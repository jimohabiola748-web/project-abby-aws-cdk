# AWS Infrastructure with CDK and GitHub Actions

A secure, scalable web infrastructure on AWS, defined as code with the AWS CDK
(TypeScript) and deployed automatically by GitHub Actions.

```
Internet
   |
   v
Application Load Balancer      (public subnets)
   |
   v
Auto Scaling Group of EC2      (private subnets, Amazon Linux 2023)
   |
   v
RDS database                   (private subnets, credentials in Secrets Manager)
```

## What gets created

| Area | Resources |
|------|-----------|
| Networking | VPC (`10.20.0.0/16`), public + private subnets in 2 Availability Zones, internet gateway, NAT gateway(s) |
| Security groups | **ALB**: HTTP 80 / HTTPS 443 from the internet. **EC2**: 80/443 only from the ALB group. **Database**: the database port only from the EC2 group, outbound restricted |
| Compute | Launch template (Amazon Linux 2023, IMDSv2 required) and an Auto Scaling Group with CPU target tracking at 50% |
| Load balancing | Public ALB, target group with a `/health` check, HTTP listener on 80, optional HTTPS listener on 443 |
| Database | RDS PostgreSQL (or MySQL), 20 GB gp2, encrypted, credentials generated into AWS Secrets Manager |

## Project layout

```
bin/aws-infra.ts              entry point (creates one stack per stage)
lib/config.ts                 all parameters and defaults, in one place
lib/aws-infra-stack.ts        the stack: VPC, security groups, ASG, ALB, RDS
.github/workflows/deploy.yml  the GitHub Actions pipeline
```

## Configuration parameters

Defaults come from `lib/config.ts`. Override any of them without editing code,
either with `-c name=value` on the command line or with a `"context"` block in
`cdk.json`.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `vpcCidr` | CIDR range for the VPC | `10.20.0.0/16` |
| `instanceType` | EC2 instance type | `t2.micro` |
| `desiredCapacity` | ASG desired instance count | `2` |
| `minCapacity` | ASG minimum instance count | `1` |
| `maxCapacity` | ASG maximum instance count | `4` |
| `dbEngine` | RDS engine (`postgres` or `mysql`) | `postgres` |
| `dbStorage` | Database storage in GB | `20` |
| `dbInstanceType` | RDS instance class | `db.t3.micro` |
| `dbMultiAz` | Multi-AZ database (optional) | `false` |
| `natGateways` | Number of NAT gateways | `1` |
| `healthCheckPath` | Target group health check path | `/health` |
| `certificateArn` | ACM certificate, turns on the HTTPS listener | _(none)_ |
| `stage` | Name of the environment (`staging`, `production`) | `dev` |

Example:

```
npx cdk deploy -c stage=staging -c maxCapacity=6 -c dbMultiAz=true
```

Invalid values (for example `desiredCapacity` above `maxCapacity`) stop with a
clear error before anything is sent to AWS.

---

# 1. Environment setup

### On your computer

1. Install **Node.js 20 or newer** (22 recommended) from nodejs.org.
2. Install the **AWS CLI** and run `aws configure`, or sign in with your usual method.
3. Check you are logged in to the right account:
   ```
   aws sts get-caller-identity
   ```
4. Install the project:
   ```
   npm install
   ```
5. Check the stack builds. This only creates the CloudFormation template on your
   computer and costs nothing:
   ```
   npx cdk synth
   ```

### In AWS (one time) - let GitHub deploy for you

GitHub Actions logs in to AWS with an **IAM role** (OpenID Connect) instead of
stored access keys.

1. In the AWS console go to **IAM > Identity providers > Add provider**.
   Choose **OpenID Connect**, provider URL `https://token.actions.githubusercontent.com`,
   audience `sts.amazonaws.com`.
2. Create an **IAM role** for a web identity using that provider, with this trust
   policy (replace the account ID, your GitHub user or organisation, and the repository name):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<GITHUB_USER>/<REPO_NAME>:*" }
       }
     }]
   }
   ```
3. Give the role permission to deploy. For a learning project,
   `AdministratorAccess` is the simplest. For anything real, use a narrower policy.
4. Copy the role's ARN.

### In GitHub (one time)

1. Repository **Settings > Secrets and variables > Actions**:
   - Secret `AWS_ROLE_ARN` = the role ARN from above.
   - Optional variable `AWS_REGION` (the pipeline defaults to `ca-central-1`).
2. Repository **Settings > Environments**: create `staging` and `production`.
   On `production`, add **Required reviewers** if you want a person to approve
   production deployments.

> Simpler alternative: store `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as
> secrets and use them in the "Log in to AWS" steps instead of `role-to-assume`.
> This works, but long-lived keys are less safe than the role.

---

# 2. Deployment process

### How the pipeline works

| Stage | AWS service option | What this project uses |
|-------|--------------------|------------------------|
| Source | CodeCommit | GitHub |
| Build | CodeBuild | GitHub Actions (`build` job) |
| Staging | CodeBuild | GitHub Actions (`deploy-staging` job) |
| Production | CodeDeploy | GitHub Actions (`deploy-production` job) |

1. A developer pushes code to GitHub.
2. The pipeline runs on every push to, or pull request into, `main`.
3. **Build** installs the packages, type-checks, and runs `cdk synth` (generates
   the CloudFormation template).
4. On a **pull request** the pipeline stops after the build, so nothing is deployed
   until the change is merged.
5. On a **push to `main`** it continues: it runs `cdk bootstrap` only if the account
   was never bootstrapped, then `cdk deploy` to **staging**, and when that succeeds
   `cdk deploy` to **production**.
6. The deploy output prints `LoadBalancerUrl`. Open it in a browser. You should see
   "Hello from ..." and refreshing may show a different instance name.

### Deploying by hand

```
npx cdk bootstrap                       # first time per account and region only
npx cdk deploy -c stage=staging         # type y to approve the IAM and security changes
```

To see what a change would do before deploying: `npx cdk diff -c stage=staging`

### Idempotency

Running `cdk deploy` again with the same code and settings changes nothing. CDK
sends the same template to CloudFormation, which reports "no changes" and does not
create duplicates. One thing to know: because `desiredCapacity` is set, a deploy
resets the Auto Scaling Group back to that number if autoscaling had changed it.

### Checking that it works

```
aws cloudformation describe-stacks --stack-name AwsInfra-staging --query "Stacks[0].Outputs"
```

- ALB to EC2: open `LoadBalancerUrl`. Targets should show **healthy** in
  EC2 > Target Groups.
- EC2 to RDS: the EC2 security group is the only source allowed on the database
  port, and the instances can read the secret named in `DatabaseSecretArn`.

### Tearing everything down

```
npm run destroy:staging
npm run destroy:production
```

The database uses a `DESTROY` removal policy, so **its data is deleted too**. The
shared bootstrap stack (`CDKToolkit`) is not removed.

> **Cost note:** NAT gateways, the ALB and RDS cost money while they exist, even when
> idle. Destroy the stacks when you are done testing.

---

# 3. Rollback procedures

**A deploy fails halfway.** CloudFormation rolls the stack back to the last working
state automatically. Read the reason under CloudFormation > Stacks > *Events*, fix
the code, and push again.

**A bad change was deployed successfully.** Roll forward to the old code:

1. Find the bad commit and run `git revert <commit-id>`.
2. Push to `main`. The pipeline deploys the reverted code to staging, then production.

**The pipeline is unavailable.** Deploy a known good version by hand:

```
git checkout <good-commit-id>
npm ci
npx cdk deploy -c stage=production
```

**Only a setting needs to change** (for example too few servers): redeploy with
the new value, e.g. `npx cdk deploy -c stage=production -c minCapacity=2`.

**The stack is stuck in `ROLLBACK_COMPLETE`.** This happens when the very first
deployment fails. Delete the stack (`npx cdk destroy -c stage=<stage>`) and deploy again.

**Database data.** A rollback restores the infrastructure, not the data. Before a risky
change, take a snapshot: RDS console > your database > Actions > Take snapshot.
