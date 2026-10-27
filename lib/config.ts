import { Node } from "constructs";

// ---------------------------------------------------------
// All the CDK configuration parameters live in this one file.
// The defaults match the table in section 4 of the requirement
// document. Any of them can be overridden without touching the
// code, either on the command line:
//
//     npx cdk deploy -c maxCapacity=6 -c instanceType=t3.small
//
// or by adding a "context" block to cdk.json.
// ---------------------------------------------------------
export interface InfraConfig {
  stage: string; // staging / production / dev
  vpcCidr: string;
  instanceType: string;
  desiredCapacity: number;
  minCapacity: number;
  maxCapacity: number;
  dbEngine: "postgres" | "mysql";
  dbStorage: number; // GB
  dbInstanceType: string;
  // extras that the document calls "optional" or "configurable"
  dbMultiAz: boolean;
  natGateways: number;
  healthCheckPath: string;
  certificateArn: string; // empty = no HTTPS listener
}

const DEFAULTS: InfraConfig = {
  stage: "dev",
  vpcCidr: "10.20.0.0/16",
  instanceType: "t3.micro",
  desiredCapacity: 1,
  minCapacity: 1,
  maxCapacity: 1,
  dbEngine: "postgres",
  dbStorage: 20,
  dbInstanceType: "db.t3.micro",
  dbMultiAz: false,
  natGateways: 1,
  healthCheckPath: "/health",
  certificateArn: "",
};

export function readConfig(node: Node): InfraConfig {
  // reads a value from CDK context, or falls back to the default
  const get = (key: keyof InfraConfig) => {
    const value = node.tryGetContext(key);
    return value === undefined ? DEFAULTS[key] : value;
  };

  const config: InfraConfig = {
    stage: String(get("stage")),
    vpcCidr: String(get("vpcCidr")),
    instanceType: String(get("instanceType")),
    desiredCapacity: Number(get("desiredCapacity")),
    minCapacity: Number(get("minCapacity")),
    maxCapacity: Number(get("maxCapacity")),
    dbEngine: String(get("dbEngine")).toLowerCase() as "postgres" | "mysql",
    dbStorage: Number(get("dbStorage")),
    dbInstanceType: String(get("dbInstanceType")),
    // values passed with -c arrive as strings, so "true" must be converted
    dbMultiAz: String(get("dbMultiAz")) === "true",
    natGateways: Number(get("natGateways")),
    healthCheckPath: String(get("healthCheckPath")),
    certificateArn: String(get("certificateArn")),
  };

  // Stop early with a clear message instead of a confusing AWS error later.
  if (config.dbEngine !== "postgres" && config.dbEngine !== "mysql") {
    throw new Error(`dbEngine must be "postgres" or "mysql", got "${config.dbEngine}"`);
  }
  if (config.minCapacity > config.maxCapacity) {
    throw new Error("minCapacity cannot be bigger than maxCapacity");
  }
  if (config.desiredCapacity < config.minCapacity || config.desiredCapacity > config.maxCapacity) {
    throw new Error("desiredCapacity must be between minCapacity and maxCapacity");
  }
  if (config.dbStorage < 20) {
    throw new Error("dbStorage must be at least 20 GB");
  }

  return config;
}
