import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import { readConfig } from "./config";

export class AwsInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const config = readConfig(this.node);

    // ---------------------------------------------------------
    // 2.1 NETWORKING
    // Public + private subnets in 2 Availability Zones, with NAT
    // gateway(s) so the private subnets can reach the internet.
    // ---------------------------------------------------------
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 2,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // ---------------------------------------------------------
    // 2.2 SECURITY GROUPS
    // Internet -> ALB group -> EC2 group -> Database group
    // Each group only trusts the group in front of it.
    // ---------------------------------------------------------
    const dbPort = config.dbEngine === "mysql" ? 3306 : 5432;

    const albSg = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "ALB: HTTP/HTTPS from the internet",
      allowAllOutbound: true, // outbound: allow all traffic
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP from public");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS from public");

    const ec2Sg = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc,
      description: "EC2: traffic only from the ALB",
      allowAllOutbound: true, // outbound: allow all traffic
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(80), "HTTP from ALB only");
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(443), "HTTPS from ALB only");

    const dbSg = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      description: "Database: traffic only from the EC2 instances",
      allowAllOutbound: false, // outbound: restricted to necessary egress only
    });
    dbSg.addIngressRule(ec2Sg, ec2.Port.tcp(dbPort), "Database port from EC2 only");

    // ---------------------------------------------------------
    // 2.3 COMPUTE: launch template + auto scaling group
    // ---------------------------------------------------------
    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        // lets us open a shell with Session Manager instead of SSH
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // A tiny web server so the load balancer has something to check.
    // /health is the path the target group health check calls.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "dnf install -y nginx",
      "mkdir -p /usr/share/nginx/html",
      'echo "OK" > /usr/share/nginx/html/health',
      'echo "<h1>Hello from $(hostname -f)</h1>" > /usr/share/nginx/html/index.html',
      "systemctl enable --now nginx"
    );

    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: new ec2.InstanceType(config.instanceType),
      securityGroup: ec2Sg,
      role: instanceRole,
      userData,
      requireImdsv2: true,
    });

    const asg = new autoscaling.AutoScalingGroup(this, "AutoScalingGroup", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplate,
      minCapacity: config.minCapacity,
      maxCapacity: config.maxCapacity,
      desiredCapacity: config.desiredCapacity,
      // replace instances that fail the load balancer health check too
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.minutes(5),
      }),
    });

    // Target tracking: keep average CPU around 50%
    asg.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
    });

    // ---------------------------------------------------------
    // 2.4 LOAD BALANCING
    // ---------------------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
      healthCheck: {
        path: config.healthCheckPath,
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
      },
    });

    // HTTP (80) forwards traffic to the target group.
    alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // the ALB security group already controls access
      defaultTargetGroups: [targetGroup],
    });

    // Optional HTTPS (443): only added when a certificate ARN is given, e.g.
    //     npx cdk deploy -c certificateArn=arn:aws:acm:...
    if (config.certificateArn) {
      alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        open: false,
        certificates: [elbv2.ListenerCertificate.fromArn(config.certificateArn)],
        defaultTargetGroups: [targetGroup],
      });
    }

    // ---------------------------------------------------------
    // 2.5 DATABASE
    // ---------------------------------------------------------
    const engine =
      config.dbEngine === "mysql"
        ? rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 })
        : rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 });

    const database = new rds.DatabaseInstance(this, "Database", {
      engine,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      // CDK adds the "db." prefix itself, so we remove it if it was typed
      instanceType: new ec2.InstanceType(config.dbInstanceType.replace(/^db\./, "")),
      allocatedStorage: config.dbStorage,
      storageType: rds.StorageType.GP2,
      multiAz: config.dbMultiAz,
      storageEncrypted: true,
      databaseName: "appdb",
      // username + a random password, stored in AWS Secrets Manager
      credentials: rds.Credentials.fromGeneratedSecret("dbadmin"),
      // so that "cdk destroy" removes everything cleanly
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      deleteAutomatedBackups: true,
    });

    // The app servers are allowed to read the database credentials.
    database.secret?.grantRead(instanceRole);

    // ---------------------------------------------------------
    // Outputs and tags
    // ---------------------------------------------------------
    new cdk.CfnOutput(this, "LoadBalancerUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "Open this in a browser to reach the app servers",
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: database.dbInstanceEndpointAddress,
    });
    if (database.secret) {
      new cdk.CfnOutput(this, "DatabaseSecretArn", { value: database.secret.secretArn });
    }

    cdk.Tags.of(this).add("Project", "aws-infra-cdk");
    cdk.Tags.of(this).add("Stage", config.stage);
  }
}
