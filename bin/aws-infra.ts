#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsInfraStack } from "../lib/aws-infra-stack";

const app = new cdk.App();

// The stage decides the stack name, so "staging" and "production" are two
// separate copies of the infrastructure:
//     npx cdk deploy -c stage=staging
//     npx cdk deploy -c stage=production
const stage = app.node.tryGetContext("stage") ?? "dev";

new AwsInfraStack(app, `AwsInfra-${stage}`, {
  // Uses whatever AWS account and region your CLI/credentials point at.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
