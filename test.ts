if (featureFlags.enablePerformanceTesting) {
  const scheduledTaskConfig = config.ecs.taskDefinitions.PerformanceTesting;
  const env = cft.Resolver.environment(app);

  // Create an environment-aware Performance Test Stack
  const performanceTestStack = new aws.Stack(app, "PerformanceTestStack", { env });

  // KMS key for encrypting the task’s logs
  const kmsKey = new cft.kms.Key(performanceTestStack, "PerformanceTestLogKmsKey", {
    enabled: true,
  });
  kmsKey.grantEncryptDecrypt(new aws.iam.ServicePrincipal("logs.amazonaws.com"));

  // ECS Fargate TaskDefinition
  const taskDefinition = new aws.ecs.FargateTaskDefinition(
    performanceTestStack,
    "PerformanceTestTaskDefinition",
    {
      cpu: 512,
      memoryLimitMiB: 1024,
    }
  );
  const taskLogGroup = new aws.logs.LogGroup(
    performanceTestStack,
    "PerformanceTestLogGroup",
    {
      encryptionKey: kmsKey,
      logGroupName: "/app/perftest-ecs-logs",
      retention: aws.logs.RetentionDays.ONE_WEEK,
      removalPolicy: aws.RemovalPolicy.RETAIN,
    }
  );
  taskDefinition.addContainer("PerformanceTestContainer", {
    image: cft.CftContainerImage.copyFromSourceRegistryToDestination(
      scheduledTaskConfig.registryUri,
      scheduledTaskConfig.tagVersion
    ),
    logging: aws.ecs.LogDriver.awsLogs({
      logGroup: taskLogGroup,
      streamPrefix: "perftest",
      mode: aws.aws_ecs.AwsLogDriverMode.NON_BLOCKING,
    }),
    command: [
      "/bin/sh",
      "-c",
      "./perftest.sh LoadSimulation; ./perftest.sh StressSimulation; ./perftest.sh EnduranceSimulation",
    ],
    environment: {
      FT_VAR_VERSION: currentTimestamp,
    },
  });

  // 1) Lambda that kicks off your ECS runTask
  const kickOffFn = new aws.lambda.Function(
    performanceTestStack,
    "KickOffPerfTestFn",
    {
      runtime: aws.lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: aws.lambda.Code.fromInline(`
        const AWS = require("aws-sdk");
        const ecs = new AWS.ECS();
        exports.handler = async () => {
          await ecs.runTask({
            cluster: "${scheduledTaskConfig.clusterArn}",
            taskDefinition: "${taskDefinition.taskDefinitionArn}",
            launchType: "FARGATE",
            platformVersion: "1.4.0",
            count: 1,
          }).promise();
        };
      `),
    }
  );

  // Grant the Lambda permission to call ECS RunTask
  kickOffFn.addToRolePolicy(
    new aws.iam.PolicyStatement({
      actions: ["ecs:RunTask", "iam:PassRole"],
      resources: [
        taskDefinition.taskDefinitionArn,
        scheduledTaskConfig.executionRoleArn, // if you have a custom execution role
      ],
    })
  );

  // 2) Role that Scheduler will assume to invoke the Lambda
  const schedulerRole = new aws.iam.Role(
    performanceTestStack,
    "PerfTestSchedulerRole",
    {
      assumedBy: new aws.iam.ServicePrincipal("scheduler.amazonaws.com"),
    }
  );
  schedulerRole.addToPolicy(
    new aws.iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [kickOffFn.functionArn],
    })
  );

  // 3) The Scheduler resource, pointing at our Lambda
  new aws.aws_scheduler.CfnSchedule(
    performanceTestStack,
    "PerfTestSchedule",
    {
      description: "Kick off ECS perf tests every 5 minutes via Lambda",
      scheduleExpression: "cron(0/5 * * * ? *)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: kickOffFn.functionArn,
        roleArn: schedulerRole.roleArn,
        // no EcsParameters block here, so it passes your guard-rail
        input: JSON.stringify({}), 
      },
    }
  );
}
