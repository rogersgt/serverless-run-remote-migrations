# serverless-run-remote-migrations
Run database migrations against your database instance before deploying your serverless app.

### Why?
Building applications with relational databases requires DDL database changes (adding tables, indexes, etc); and sometimes NoSQL databases require indexing or some sort of database seeding to make the application work correctly upon next deployment. When your database is deployed in a restricted network, most of the time it's better to run a remote task within your private network instead of opening network access to the pipeline service you are using for application deployments.

This plugin handles the DevOps work for completing database migrations within your CI/CD pipelines.

## Installation
```bash
npm i serverless-run-remote-migrations
```
Or 
```bash
yarn add serverless-run-remote-migrations
```

## Usage 
```bash
serverless runRemoteMigrations
```

### What is happening in runRemoteMigrations?
#### AWS Deployment
* ECR repository is created
* ECS [Fargate](https://aws.amazon.com/fargate/pricing/) cluster is created (using standard and spot instances)
* You provided `Dockerfile` is used to build an image and check into the created ECR repo
* A cloudformation stack is created for an ECS Task definition and IAM roles necessary for execution
* ECS Task is ran in the ECS cluster using either the specified VPC or the default VPC if not specified
* Command waits for task to exit with exit code zero (success); or will throw an error if the task exits with a non-zero exit code.

## Configuration
`serverless.yml`
```YAML
plugins:
  - serverless-run-remote-migrations
...

custom:
  serverless-run-remote-migrations:
    # docker image build that contains database migrations code
    build:
      dockerfile: path/to/Dockerfile # (Required)
      context: . # (Optional, Default: ".") See https://docs.docker.com/build/building/context
      # Recommended to tag code with current commit SHA (i.e. export COMMIT_SHA=$(git rev-parse HEAD) and use ${env:COMMIT_SHA}).
      # See https://docs.docker.com/engine/reference/commandline/tag/
      tag: latest # (Optional, Default "latest")
    deploy:
      cpu: 256 # (Optional, Default: 256)
      memory: 512 # (Optional, Default: 512)
      command: # (Required)
        - some
        - command
      # currently only aws is supported (although you can run images from Dockerhub or anywhere)
      aws: # Can also use 'aws: true' here to use default VPC and default VPC security group
        stackName: any-stack-name-for-migrations-task # (Optional, a stack name will be generated like "${appName}-${stage}-migrations")
        vpc:
          securityGroupId: sg-xxxxx # (Optional) will use default VPC security group if none provided
          subnetId: subnet-xxxxx # (Optional) will use random subnet in default VPC if none provided
          autoAssignPublicIp: ENABLED # ENABLED | DISABLED (Optional, Default "ENABLED") Use false if subnetId is private
        secret: # (Options) will be omitted if not specified
          name: DATABASE_URL # (Optional) Will default to DATABASE_URL
          valueFrom: arn:aws:ssm:<region>:<account-id>:parameter/path/to/SECRET # (Required) Either SSM Parameter /arn or AWS Secret Arn to securely mount value into migrations task
        taskRoleArn: arn:aws:iam::<account-id>:role/<task-role-name> # (Optional) Use an IAM role to grant migrations process IAM privileges
```
