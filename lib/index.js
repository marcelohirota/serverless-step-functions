'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const chalk = require('chalk');
const httpAuthorizers = require('./deploy/events/apiGateway/authorizers');
const compileStateMachines = require('./deploy/stepFunctions/compileStateMachines');
const compileActivities = require('./deploy/stepFunctions/compileActivities');
const compileIamRole = require('./deploy/stepFunctions/compileIamRole');
const compileAlarms = require('./deploy/stepFunctions/compileAlarms');
const compileNotifications = require('./deploy/stepFunctions/compileNotifications');
const httpValidate = require('./deploy/events/apiGateway/validate');
const httpResources = require('./deploy/events/apiGateway/resources');
const httpMethods = require('./deploy/events/apiGateway/methods');
const httpRequestValidators = require('./deploy/events/apiGateway/requestValidators');

// eslint-disable-next-line max-len
const httpCors = require('./deploy/events/apiGateway/cors');
const httpApiKeys = require('./deploy/events/apiGateway/apiKeys');
const httpUsagePlan = require('./deploy/events/apiGateway/usagePlan');
const httpUsagePlanKeys = require('./deploy/events/apiGateway/usagePlanKeys');
const httpIamRole = require('./deploy/events/apiGateway/iamRole');
const httpLambdaPermissions = require('./deploy/events/apiGateway/lambdaPermissions');
const httpDeployment = require('./deploy/events/apiGateway/deployment');
const httpRestApi = require('./deploy/events/apiGateway/restApi');
const httpInfo = require('./deploy/events/apiGateway/endpointInfo');
const compileScheduledEvents = require('./deploy/events/schedule/compileScheduledEvents');
const compileCloudWatchEventEvents = require('./deploy/events/cloudWatchEvent/compileCloudWatchEventEvents');
const invoke = require('./invoke/invoke');
const yamlParser = require('./yamlParser');
const naming = require('./naming');

const logger = require('./utils/logger');

class ServerlessStepFunctions {
  constructor(serverless, options, v3Api) {
    this.serverless = serverless;
    this.options = options || {};
    this.v3Api = v3Api;

    this.provider = this.serverless.getProvider('aws');
    this.service = this.serverless.service.service;
    this.region = this.serverless.service.provider.region;
    this.stage = this.serverless.service.provider.stage || 'ap-southeast-2';

    // Handle v4 API
    if (serverless.version && serverless.version[0] === '4') {
      this.configSchemaHandler = serverless.configSchemaHandler;
    }

    logger.config(serverless, v3Api);
    Object.assign(
      this,
      compileStateMachines,
      compileActivities,
      compileIamRole,
      compileAlarms,
      compileNotifications,
      httpRestApi,
      httpInfo,
      httpValidate,
      httpResources,
      httpMethods,
      httpRequestValidators,
      httpAuthorizers,
      httpLambdaPermissions,
      httpCors,
      httpApiKeys,
      httpUsagePlan,
      httpUsagePlanKeys,
      httpIamRole,
      httpDeployment,
      invoke,
      yamlParser,
      naming,
      compileScheduledEvents,
      compileCloudWatchEventEvents,
    );

    this.commands = {
      invoke: {
        commands: {
          stepf: {
            usage: 'Invoke Step functions',
            lifecycleEvents: [
              'invoke',
            ],
            options: {
              name: {
                usage: 'The StateMachine name',
                shortcut: 'n',
                required: true,
                type: 'string',
              },
              data: {
                usage: 'String data to be passed as an event to your step function',
                shortcut: 'd',
                type: 'string',
              },
              path: {
                usage:
                'The path to a json file with input data to be passed to the invoked step function',
                shortcut: 'p',
                type: 'string',
              },
              stage: {
                usage: 'Stage of the service',
                shortcut: 's',
                type: 'string',
              },
              region: {
                usage: 'Region of the service',
                shortcut: 'r',
                type: 'string',
              },
            },
          },
        },
      },
    };

    this.hooks = {
      'invoke:stepf:invoke': () => BbPromise.bind(this)
        .then(this.yamlParse)
        .then(this.invoke),
      'package:initialize': () => BbPromise.bind(this)
        .then(this.yamlParse),
      'package:compileFunctions': () => BbPromise.bind(this)
        .then(this.compileIamRole)
        .then(this.compileStateMachines)
        .then(this.compileActivities)
        .then(this.compileAlarms)
        .then(this.compileNotifications),
      'package:compileEvents': () => this.compileScheduledEvents().then(() => {
        // FIXME: Rename pluginhttpValidated to validated
        // so that we can use internal serverless libraries
        this.pluginhttpValidated = this.httpValidate();
        this.validated = this.pluginhttpValidated;

        if (this.pluginhttpValidated.events.length === 0) {
          return BbPromise.resolve();
        }

        return BbPromise.bind(this)
          .then(this.compileRestApi)
          .then(this.compileResources)
          .then(this.compileMethods)
          .then(this.compileRequestValidators)
          .then(this.compileAuthorizers)
          .then(this.compileHttpLambdaPermissions)
          .then(this.compileCors)
          .then(this.compileHttpIamRole)
          .then(this.compileDeployment)
          .then(this.compileApiKeys)
          .then(this.compileUsagePlan)
          .then(this.compileUsagePlanKeys);
      }).then(() => this.compileCloudWatchEventEvents()),
      'after:deploy:deploy': () => BbPromise.bind(this)
        .then(this.getEndpointInfo)
        .then(this.display),
    };

    if (this.serverless.version && this.serverless.version[0] === '4') {
      const stepFunctionsSchema = {
        type: 'object',
        properties: {
          stateMachines: { type: 'object' },
          validate: { type: 'boolean' },
          noOutput: { type: 'boolean' },
          activities: { type: 'array' },
        },
        required: ['stateMachines'],
      };
      this.serverless.configSchemaHandler.defineCustomProperties({
        type: 'object',
        properties: {
          stepFunctions: stepFunctionsSchema,
        },
      });
    }
  }

  invoke() {
    return BbPromise.bind(this)
      .then(this.getStateMachineArn)
      .then(this.startExecution)
      .then(this.describeExecution)
      .then((result) => {
        logger.log('');
        if (result.status === 'FAILED') {
          return this.getExecutionHistory()
            .then((error) => {
              logger.log(_.merge(result, error.events[error.events.length - 1]
                .executionFailedEventDetails));
              process.exitCode = 1;
            });
        }

        logger.log(result);
        return BbPromise.resolve();
      });
  }

  display() {
    let message = '';
    let stateMachineMessages = '';

    const endpointInfo = this.endpointInfo;

    if (this.v3Api) {
      const slsRed = chalk.hex('#fd5750');
      message += `\n${slsRed('✔')} Serverless StepFunctions Outputs\n`;
      message += `${chalk.grey('endpoints:')}`;
    } else {
      message += `${chalk.yellow.underline('Serverless StepFunctions Outputs')}\n`;
      message += `${chalk.yellow('endpoints:')}`;
    }

    if (this.isStateMachines()) {
      _.forEach(this.getAllStateMachines(), (stateMachineName) => {
        const stateMachineObj = this.getStateMachine(stateMachineName);
        if (stateMachineObj.events != null && _.isArray(stateMachineObj.events)) {
          stateMachineObj.events.forEach((event) => {
            if (event.http) {
              let method;
              let path;

              if (typeof event.http === 'object') {
                method = event.http.method.toUpperCase();
                path = event.http.path;
              } else {
                method = event.http.split(' ')[0].toUpperCase();
                path = event.http.split(' ')[1];
              }
              path = path !== '/' ? `/${path.split('/').filter(p => p !== '').join('/')}` : '';
              stateMachineMessages += `\n  ${method} - ${endpointInfo}${path}`;
            }
          });
        }
      });
    }

    if (_.isEmpty(stateMachineMessages)) {
      return '';
    }

    message += stateMachineMessages;
    message += '\n';

    logger.log(message);

    return message;
  }
}
module.exports = ServerlessStepFunctions;
