const aws = require('aws-sdk');

const LOGLEVEL = process.env.LOGLEVEL || "INFO";
const VANTAGE_KEY = process.env.VANTAGE_KEY || "";
const SLACK_HOOK = process.env.SLACK_HOOK || "";

exports.handler = async (event, context) => {
  const describeScheduledActions = async (asg) => {
    console.debug("[DEBUG] describeScheduledActions in " + asg.config.region);
    const resp = asg.describeScheduledActions().promise();
    return resp;
  };
  const describeAutoScalingGroups = async (asg) => {
    console.debug("[DEBUG] describeAutoScalingGroups in " + asg.config.region);
    const resp = asg.describeAutoScalingGroups().promise();
    return resp;
  };
  const listAutoScalingGroupsWithoutScaleDownAction = async region => {
    const controller = new aws.AutoScaling({ apiVersion: '2011-01-01', region: region });
    const responses = await Promise.all([describeAutoScalingGroups(controller), describeScheduledActions(controller)]);
    const msg = `[INFO] Region ${region}, Found ${responses[0].AutoScalingGroups.length} asg and ${responses[1].ScheduledUpdateGroupActions.length} actions`;
    console.log(msg);
    const filtered = responses[0].AutoScalingGroups
      .filter(asg =>
        responses[1].ScheduledUpdateGroupActions
          .filter(act =>
            act.AutoScalingGroupName == asg.AutoScalingGroupName && act.DesiredCapacity == 0)
          .length == 0);
    filtered.forEach(itm => {
      itm.Region = region;
      console.log(`[WARN] Region ${region}, ASG ${itm.AutoScalingGroupName} has no action to scale it to zero, and a current size of ${itm.DesiredCapacity}`);
    });
    return filtered;
  };
  const listEC2InstancesThatAreNotInAnyASG = async region => {
    console.debug("[DEBUG] listEC2InstancesThatAreNotInAnyASG in " + region);
    const controller = new aws.EC2({ apiVersion: '2016-11-15', region: region });
    const params = {
      Filters: [
        { Name: "instance-state-name", Values: ["running"] }
      ]
    };
    const resp = await controller.describeInstances(params).promise();
    const filteredResp = resp.Reservations
      .map(reservation => reservation.Instances
        .filter(instance => instance.Tags
          .some(tag => tag.Key == "aws:autoscaling:groupName") == false))
      .flat();
    filteredResp.forEach(itm => {
      itm.Region = region;
      console.log(`[WARN] Region ${region}, EC2 ${itm.InstanceId} size ${itm.InstanceType} is running and not part of any ASG`);
      return;
    });
    return filteredResp;
  };

  const groupByTagPrefix_EC2 = (arr, tagPrefix) => {
    const result = arr.reduce((previousValue, currentValue) => {
      let cluster = currentValue.Tags
        .filter(tag => tag.Key.startsWith(tagPrefix))
        .reduce((r, tag) => tag.Key, {});
      let name = currentValue.Tags
        .filter(tag => tag.Key == 'Name')
        .reduce((r, tag) => tag.Value, false);
      cluster = (cluster && Object.keys(cluster).length === 0 && Object.getPrototypeOf(cluster) === Object.prototype) ?
        (name || currentValue.InstanceId) : cluster;
      previousValue[cluster] = previousValue[cluster] || {};
      previousValue[cluster].type = "EC2";
      previousValue[cluster].count = (previousValue[cluster].count || 0) + 1;
      previousValue[cluster].size = currentValue.InstanceType;
      previousValue[cluster].region = currentValue.Region;
      //previousValue[cluster].lastInstanceFound = currentValue;

      return previousValue;
    }, {});
    return result;
  };

  const groupByTagPrefix_ASG = (arr, tagPrefix) => {
    const result = arr.reduce((previousValue, currentValue) => {
      let cluster = currentValue.Tags
        .filter(tag => tag.Key.startsWith(tagPrefix))
        .reduce((r, tag) => tag.Key, {});
      cluster = (cluster && Object.keys(cluster).length === 0 && Object.getPrototypeOf(cluster) === Object.prototype) ?
        currentValue.AutoScalingGroupName : cluster;
      previousValue.push({
        type: "AutoScalingGroup",
        count: currentValue.Instances.length,
        size: currentValue.Instances[0].InstanceType,
        region: currentValue.Region,
        //lastInstanceFound: currentValue,
        totalCost: currentValue.totalCost,
        name: cluster,
      });
      return previousValue;
    }, []);
    return result;
  };

  const calculateCostCache = async (product) => {
    const cacheHit = costCache.filter(x => x.id == product);
    if (cacheHit.length > 0) {
      return cacheHit;
    }
    console.log("[INFO] cache miss: " + product);
    var https = require('https');
    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.vantage.sh',
        path: '/v1/products/aws-ec2-' + product.split("-")[2] + '/prices/' + product,
        protocol: 'https:',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': VANTAGE_KEY
        }
      };
      const req = https.get(options, function (res) {
        res.setEncoding('utf8');
        var dataString = '';
        res.on('data', chunk => {
          dataString += chunk;
        });
        res.on('end', () => {
          resolve(JSON.parse(dataString));
        });
      });
      req.on('error', (e) => { reject({ statusCode: 500, body: 'Something went wrong! ' + e }); });
    });
    return response;
  };
  const includeCostInfoForEC2 = async obj => {
    const uniqueArr = [... new Set(Object.entries(obj).map(data => {
      console.log(`[DEBUG]includeCostInfoForEC2: Region ${data[1].region}, size ${data[1].size}, obj ${data[0]}`);
      return "aws-ec2-" + data[1].size.replace(/\./g, "_") + "-" + data[1].region.replace(/-/g, "_") + "-on_demand-linux";
    }))];
    costCache = costCache.concat(await Promise.all(uniqueArr.map(x => calculateCostCache(x))));
    Object.entries(obj).forEach(
      itm => {
        let cost = costCache.filter(x => x.region == itm[1].region && x.id.includes(itm[1].size.replace(".", "_")));
        itm[1].totalCost = itm[1].count * cost[0].amount * 730;
        itm[1].name = itm[0];
      }
    );
    let sortedArr = Object.entries(obj).sort(
      (a, b) => b[1].totalCost - a[1].totalCost);
    return sortedArr.map(x => x[1]);
  };
  const includeCostInfoForASG = async obj => {
    const uniqueArr = [... new Set(obj.map(x => { return { instances: x.Instances, region: x.Region } }).flat().map(data => {
      console.log(`[DEBUG]includeCostInfoForASG: Region ${data.region}, size ${data.size}, obj ${data}`);
      return "aws-ec2-" + data.instances[0].InstanceType.replace(/\./g, "_") + "-" + data.region.replace(/-/g, "_") + "-on_demand-linux"
    }))];
    costCache = costCache.concat(await Promise.all(uniqueArr.map(x => calculateCostCache(x))));
    obj.forEach(
      itm => {
        let cost = costCache.filter(x => x.region == itm.Region && x.id.includes(itm.Instances[0].InstanceType.replace(".", "_")));
        itm.totalCost = itm.Instances.length * cost[0].amount * 730;
      }
    );
    let sortedArr = obj.sort(
      (a, b) => b.totalCost - a.totalCost);
    return sortedArr;
  };
  const postSlackMessage = async (title, payload) => {
    if (!SLACK_HOOK || SLACK_HOOK.length == 0){
      return;
    }
    var https = require('https');
    const response = await new Promise((resolve, reject) => {
      const prettyPayload = json => {
        // https://app.slack.com/block-kit-builder
        let res = { blocks: [] };
        res.blocks.push({ type: "section", text: { type: "mrkdwn", text: title } });
        res.blocks.push({ type: "divider" });
        json.forEach(x => {
          res.blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${x.type}: ${x.name} \n${":moneybag:".repeat(x.totalCost / 100)} *$${x.totalCost}* ${x.count}x ${x.size} instances in ${x.region}`
            }
          });
        });
        return res;
      }
      const data = new TextEncoder().encode(
        JSON.stringify(prettyPayload(payload))
      )
      const options = {
        hostname: 'hooks.slack.com',
        protocol: 'https:',
        path: SLACK_HOOK,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }

      const req = https.request(options, res => {
        console.log(`statusCode: ${res.statusCode}`)

        res.on('data', d => {
          process.stdout.write(d)
        })
      })

      req.on('error', error => {
        console.error(error)
      })

      req.write(data)
      req.end()

    });
    return response;
  };
  let costCache = [];
  try {
    const reg = await new aws.EC2({ apiVersion: '2016-11-15', region: "eu-west-1" }).describeRegions().promise();
    const regions = reg.Regions.map(regionObj => regionObj.RegionName);
    //const regions = ["us-west-1", "us-east-1"];
    let result = {}, calculations = {};

    calculations.res_asg = regions.map(region => listAutoScalingGroupsWithoutScaleDownAction(region)); // call aws api 1
    calculations.res_ec2 = regions.map(region => listEC2InstancesThatAreNotInAnyASG(region)); // call aws api 2
    calculations.res_ec2 = (await Promise.all(calculations.res_ec2)).filter(x => x.length > 0).flat(); // resolve: call aws api 2
    result.ec2 = includeCostInfoForEC2(groupByTagPrefix_EC2(calculations.res_ec2, "kubernetes.io/cluster")); // call cost api 1 + resolve so we can have cache
    calculations.res_asg = (await Promise.all(calculations.res_asg)).filter(x => x.length > 0).flat().filter(x => x.Instances.length > 0); // resolve: call aws api 1
    calculations.asgWithCost = includeCostInfoForASG(calculations.res_asg); // call cost api 2 (use cache from previous call), do not resolve yet

    result.asg = groupByTagPrefix_ASG(await calculations.asgWithCost, "kubernetes.io/cluster"); // do some work
    result.ec2 = await result.ec2;

    result.combined = [...result.asg, ...result.ec2].sort((a, b) => b.totalCost - a.totalCost);
    result.top10 = result.combined.slice(0, result.combined.length > 10 ? 10 : result.combined.length);

    await postSlackMessage("These are the *top 10* more expensive items in *[AWS]* for *[ALL REGIONS]*", result.top10);

    return result.top10;
  } catch (err) {
    console.log(err);
    const message = `Generic error. Make sure everything is ok.`;
    console.log(message);
    throw new Error(message);
  }
};
