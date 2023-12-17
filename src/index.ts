import sls from 'serverless';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  ECRClient,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand,
  GetAuthorizationTokenCommand,
  DeleteRepositoryCommand,
  ListImagesCommand,
  BatchDeleteImageCommand,
  ImageIdentifier,
} from '@aws-sdk/client-ecr';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  CreateStackCommand,
  UpdateStackCommand,
  DeleteStackCommand,
} from '@aws-sdk/client-cloudformation';
import { ECSClient, RunTaskCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import Dockerode from 'dockerode';
import {
  EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';

import { readFileSync } from 'fs';
import { normalize, join } from 'path';
import childProcess from 'child_process';

export default class ServerlessRunRemoteMigrations {
  serverless: sls;

  log: (msg: unknown) => void;

  name = 'serverless-run-remote-migrations';

  region: string;

  docker: Dockerode;

  awsCreds: {
    region: string;
  };

  lastTaskStatus: string;

  lastStackStatus: string;

  ecsClient!: ECSClient;

  cloudformationClient!: CloudFormationClient;

  ecrClient!: ECRClient;

  ec2Client!: EC2Client;

  commands: {
    [cmd: string]: {
      lifecycleEvents?: string[];
    }
  };

  hooks: {
    [name: string]: () => Promise<any>;
  };

  image?: string;

  /**
   *
   * @param {serverless} serverless Serverless Instance
   * @param {object} cliOptions serverless CLI options
   * @param {object} serverlessUtils serverless utility tools like log
   */
  constructor(serverless: sls, _cliOptions: unknown, { log }: { log: (msg: any) => void }) {
    this.serverless = serverless;

    this.log = log;
    const { region = 'us-east-1', docker = {}, deploy = {} } = this.getConfig();
    this.region = region;
    this.docker = new Dockerode({ ...docker });

    this.awsCreds = {
      region,
    };

    this.lastTaskStatus = '';
    this.lastStackStatus = '';

    if (deploy.aws) {
      this.ecsClient = new ECSClient(this.awsCreds);
      this.cloudformationClient = new CloudFormationClient(this.awsCreds);
      this.ecrClient = new ECRClient(this.awsCreds);
      this.ec2Client = new EC2Client(this.awsCreds);
    }
    this.commands = {
      runRemoteMigrations: {
        lifecycleEvents: ['run'],
      },
    };
    this.hooks = {
      'package:finalize': this.buildImage.bind(this),
      'remove:remove': this.remove.bind(this),
      'runRemoteMigrations:run': this.runRemoteMigrations.bind(this),
    };
  }

  getTaskStackName() {
    const { deploy = {} } = this.getConfig();
    const { stackName } = deploy.aws ?? {};
    if (stackName) return `${stackName}`;
    const appName = this.serverless.service.service;
    const { stage } = this.serverless.service.provider;
    return `${appName}-${stage}-migrations`;
  }

  async ecrLogin() {
    const client = this.ecrClient || new ECRClient(this.awsCreds);
    const cmd = new GetAuthorizationTokenCommand({});
    const resp = await client.send(cmd);
    return resp;
  }

  /**
   *
   * @param {import('@aws-sdk/client-ecr').ImageIdentifier[]} imageIds
   * @param {string | undefined} nextToken
   */
  async getAllImageIdsFromRepo(imageIds: ImageIdentifier[] = [], nextToken?: string) {
    const repoName = this.getRepoName();
    const { imageIds: nextImageIds, nextToken: newNextToken } = await this.ecrClient.send(new ListImagesCommand({
      repositoryName: repoName,
      nextToken,
    }));

    const allImageIds = imageIds.concat(nextImageIds ?? []);
    if (newNextToken) {
      await new Promise((res) => setTimeout(res, 1000));
      return this.getAllImageIdsFromRepo(allImageIds, newNextToken);
    }
    return allImageIds;
  }

  async remove() {
    const { deploy = {} } = this.getConfig();
    if (deploy.aws) {
      const stackName = this.getTaskStackName();
      await this.cloudformationClient.send(new DeleteStackCommand({
        StackName: stackName,
      }));
      const repositoryName = this.getRepoName();
      const imageIds = await this.getAllImageIdsFromRepo();
      await this.ecrClient.send(new BatchDeleteImageCommand({
        imageIds,
        repositoryName,
      }));
      await this.ecrClient.send(new DeleteRepositoryCommand({
        repositoryName,
      }));
    }
  }

  async upsertCloudformationStack(templatePath, parameters, stackName) {
    const client = this.cloudformationClient || new CloudFormationClient(this.awsCreds);

    try {
      const cmd = new CreateStackCommand({
        StackName: stackName,
        TemplateBody: readFileSync(templatePath).toString(),
        Parameters: parameters,
        Capabilities: ['CAPABILITY_IAM'],
      });
      await client.send(cmd);
    } catch (error: any) {
      if (!error.Error || !error.Error.Code || error.Error.Code !== 'AlreadyExistsException') {
        throw error;
      }
      const cmd = new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: readFileSync(templatePath).toString(),
        Parameters: parameters,
        Capabilities: ['CAPABILITY_IAM'],
      });
      try {
        await client.send(cmd);
      } catch (e: any) {
        if (!e.message || e.message !== 'No updates are to be performed.') {
          throw e;
        }
      }
    }

    await this.waitForStack(stackName);
    return this.getStack(stackName);
  }

  async waitForStack(stackName) {
    const stack = await this.getStack(stackName);

    if (stack) {
      const { StackStatus } = stack;
      if (StackStatus?.includes('FAILED') || StackStatus?.includes('ROLLBACK')) {
        throw new Error(`stack ${stackName} entered state ${StackStatus}`);
      }

      if (StackStatus?.includes('IN_PROGRESS')) {
        if (StackStatus !== this.lastStackStatus) {
          this.log(`${stackName}: ${StackStatus}`);
        }
        this.lastTaskStatus = StackStatus;
        await new Promise((res) => setTimeout(res, 5000));
        return this.waitForStack(stackName);
      }

      this.lastStackStatus = '';
      return stack;
    }
    throw new Error(`${stackName} not found`);
  }

  async getStack(stackName) {
    const client = this.cloudformationClient || new CloudFormationClient(this.awsCreds);
    const cmd = new DescribeStacksCommand({
      StackName: stackName,
    });
    const { Stacks: stacks = [] } = await client.send(cmd);
    if (!stacks.length) {
      throw new Error(`Stack: ${stackName} not found`);
    }
    return stacks[0];
  }

  getRepoName() {
    const appName = this.serverless.service.service;
    return `${appName}-migrations`;
  }

  exec(cmd) {
    const buff = childProcess.exec(cmd);

    return new Promise((res, rej) => {
      buff.on('message', (msg) => {
        this.log(msg);
      });
      buff.on('close', (code) => {
        if (code !== 0) {
          rej(`${cmd} failed with exit code ${code}`);
        } else {
          res(null);
        }
      });
      buff.on('error', console.error);
    });
  }

  async pushImage(username, password) {
    const image = await this.getFullImageUri();
    this.log(`pushing docker image ${image}`);
    const builtImage = await this.docker.getImage(image);

    const stream = await builtImage.push({
      // @ts-expect-error: requiring serveraddress, but it works without and idk what it should be
      authconfig: {
        username,
        password,
        // serveraddress:
      },
    }) as unknown as NodeJS.ReadableStream;
    const pushResp = await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res)));
    });
    return pushResp;
  }

  async getAccountId() {
    const stsClient = new STSClient(this.awsCreds);
    const cmd = new GetCallerIdentityCommand({});
    const { Account } = await stsClient.send(cmd);
    return String(Account);
  }

  async getRepoUri() {
    const { deploy = {} } = this.getConfig();

    let uriName = this.getRepoName();
    if (deploy.aws) {
      const accountId = await this.getAccountId();
      uriName = `${accountId}.dkr.ecr.${this.region}.amazonaws.com/${uriName}`;
    }
    return uriName;
  }

  async upsertECRRepo() {
    const ecrCient = this.ecrClient || new ECRClient(this.awsCreds);

    const repoName = this.getRepoName();
    try {
      const cmd = new DescribeRepositoriesCommand({
        repositoryNames: [repoName],
      });
      await ecrCient.send(cmd);
    } catch (error) {
      const cmd = new CreateRepositoryCommand({
        repositoryName: repoName,
      });
      await ecrCient.send(cmd);
    }
  }

  async getFullImageUri() {
    if (!this.image) {
      const repoUri = await this.getRepoUri();
      const { build = {} } = this.getConfig() || {};
      const { tag = 'latest' } = build;
      this.image = `${repoUri}:${tag}`;
    }
    return this.image;
  }

  async buildImage() {
    this.log('Building sls migrations docker image');
    const { build = {} } = this.getConfig();
    const { dockerfile, context = '.' } = build;
    if (!dockerfile) throw new Error('Provide a build.dockerfile to excute for build docker image');
    this.log(`building using ${dockerfile}`);
    await this.log('building db migrations image');
    const image = await this.getFullImageUri();
    const dockerBuild = `docker build -t ${image} -f ${dockerfile} ${context}`;
    const buff = childProcess.exec(dockerBuild);
    await new Promise((res, rej) => {
      buff.on('message', (message) => {
        this.log(message.toString());
      });
      buff.on('close', (code) => {
        if (code !== 0) {
          rej(`Migrations build exited with error code: ${code}`);
        } else {
          res(null);
        }
      });
    });
    // const fullContext = path.normalize(path.join(process.cwd(), context));
    // const stream = await this.docker.buildImage({
    //   context: fullContext,
    //   src: [dockerfile],
    // }, {
    //   t: image,
    // });
    // await new Promise((resolve, reject) => {
    //   this.docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
    // });
  }

  getConfig() {
    return this.serverless.service.custom[this.name] || {};
  }

  async runRemoteMigrations() {
    const { deploy = {} } = this.getConfig();

    await this.buildImage();
    await this.log('running database migrations');

    if (deploy.aws) {
      await this.upsertECRRepo();
      const { authorizationData } = await this.ecrLogin();
      const { authorizationToken } = authorizationData?.find((auth) => auth.authorizationToken) || {};
      const [username, password] = Buffer.from(authorizationToken ?? '', 'base64').toString().split(':');
      await this.pushImage(username, password);

      const taskStackName = this.getTaskStackName();

      const parameters = [{
        ParameterKey: 'RepoName',
        ParameterValue: this.getRepoName(),
      }, {
        ParameterKey: 'Image',
        ParameterValue: await this.getFullImageUri(),
      }, {
        ParameterKey: 'Cpu',
        ParameterValue: deploy.cpu || 256,
      }, {
        ParameterKey: 'Memory',
        ParameterValue: deploy.memory || 512,
      },
      {
        ParameterKey: 'Command',
        ParameterValue: deploy.command,
      },
      {
        ParameterKey: 'SecretMode',
        ParameterValue: deploy.aws.secret.valueFrom.startsWith('arn:aws:secretsmanager') ? 'secretsmanager' : 'ssm',
      },
      ];

      if (deploy.aws.secret && deploy.aws.secret.valueFrom) {
        parameters.push({
          ParameterKey: 'SecretArn',
          ParameterValue: deploy.aws.secret.valueFrom,
        });
        parameters.push({
          ParameterKey: 'SecretName',
          ParameterValue: deploy.aws.secret.name || 'DATABASE_URL',
        });
      }

      if (deploy.aws.taskRoleArn) {
        parameters.push({
          ParameterKey: 'TaskRoleArn',
          ParameterValue: deploy.aws.taskRoleArn,
        });
      }
      // run task
      const taskStack = await this.upsertCloudformationStack(normalize(join(__dirname, 'cloudformation.yml')), parameters, taskStackName);

      // const ec2Client = new EC2Client(this.awsCreds);
      const ecsClient = this.ecsClient || new ECSClient(this.awsCreds);

      const awsConfig = typeof deploy.aws === 'boolean' ? {} : deploy.aws;
      const { vpc = {} } = awsConfig;
      let {
        securityGroupId,
        subnetId,
      } = vpc;
      const {
        autoAssignPublicIp = 'ENABLED',
      } = vpc;

      if (!securityGroupId || !subnetId) {
        const { Vpcs: vpcs } = await this.ec2Client.send(new DescribeVpcsCommand({}));
        const defaultVpc = vpcs?.find((vpcInResponse) => vpcInResponse.IsDefault);
        if (!defaultVpc) {
          throw new Error('Default VPC not found!');
        }

        const { Subnets: subnets = [] } = await this.ec2Client.send(new DescribeSubnetsCommand({
          Filters: [{
            Name: 'vpc-id',
            Values: [defaultVpc.VpcId ?? ''],
          }],
        }));

        if (!subnets.length && !subnetId) {
          throw new Error(`No subnets found for vpc: ${defaultVpc.VpcId}`);
        }

        const { SecurityGroups: secGroups = [] } = await this.ec2Client.send(new DescribeSecurityGroupsCommand({
          Filters: [{
            Name: 'vpc-id',
            Values: [defaultVpc.VpcId ?? ''],
          }],
        }));

        if (!secGroups.length && !securityGroupId) {
          throw new Error(`No security groups found for vpc ${defaultVpc.VpcId}`);
        }

        subnetId = subnetId || subnets[0].SubnetId;
        securityGroupId = securityGroupId || secGroups[0].GroupId;
      }

      const taskArn = taskStack.Outputs?.find((o) => o.OutputKey === 'TaskArn')?.OutputValue ?? '';
      const clusterName = taskStack.Outputs?.find((o) => o.OutputKey === 'ClusterName')?.OutputValue ?? '';
      const runTaskCmd = new RunTaskCommand({
        taskDefinition: taskArn,
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: autoAssignPublicIp,
            subnets: [subnetId],
            securityGroups: [securityGroupId],
          },
        },
        launchType: 'FARGATE',
        cluster: clusterName,
      });

      const runTaskResp = await ecsClient.send(runTaskCmd);

      const arn = runTaskResp.tasks?.length ? runTaskResp.tasks[0]?.taskArn : '';
      this.waitForTask(arn, clusterName);
    }
  }

  /**
   *
   * @param {string} taskArn
   */
  async waitForTask(taskArn, cluster) {
    const cmd = new DescribeTasksCommand({
      tasks: [taskArn],
      cluster,
    });

    const { tasks = [] } = await this.ecsClient.send(cmd);

    if (!tasks.length) {
      throw new Error(`Task ${taskArn} not found`);
    }

    const task = tasks[0];
    const {
      stopCode, lastStatus, startedAt, stoppedAt, stoppedReason, containers,
    } = task;
    if (
      stopCode === 'TaskFailedToStart'
      || stopCode === 'UserInitiated'
      || stopCode === 'TerminationNotice'
      || stopCode === 'SpotInterruption'
      || stopCode === 'ServiceSchedulerInitiated'
    ) {
      throw new Error(`db migrations task status stopCode: ${stopCode}`);
    }

    if (startedAt) {
      this.log(`db migrations task started at ${startedAt}`);
    }

    if (this.lastTaskStatus !== lastStatus) {
      this.lastTaskStatus = lastStatus ?? '';
      this.log(`db migrations task: ${lastStatus}`);
    }

    if (!containers?.length) {
      throw new Error(`No containers found for task: ${task.taskArn}`);
    }
    const migrationContainer = containers[0];
    if (typeof migrationContainer.exitCode === 'undefined') {
      await new Promise((res) => setTimeout(res, 5000));
      return this.waitForTask(taskArn, cluster);
    }

    this.lastTaskStatus = '';

    if (migrationContainer.exitCode !== 0) {
      throw new Error(
        `Db migrations task exited at ${stoppedAt} with error code: ${migrationContainer.exitCode}: ${stoppedReason}: ${stopCode}`,
      );
    }

    return task;
  }
}
