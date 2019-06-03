import iam = require('@aws-cdk/aws-iam');
import lambda = require('@aws-cdk/aws-lambda');
import cdk = require('@aws-cdk/cdk');
import metadata = require('aws-sdk/apis/metadata.json');
import path = require('path');
import { CustomResource, CustomResourceProvider } from './custom-resource';

/**
 * AWS SDK service metadata.
 */
export type AwsSdkMetadata = {[key: string]: any};

const awsSdkMetadata: AwsSdkMetadata = metadata;

/**
 * An AWS SDK call.
 */
export interface AwsSdkCall {
  /**
   * The service to call
   *
   * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/index.html
   */
  readonly service: string;

  /**
   * The service action to call
   *
   * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/index.html
   */
  readonly action: string;

  /**
   * The parameters for the service action
   *
   * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/index.html
   */
  readonly parameters?: any;

  /**
   * The path to the data in the API call response to use as the physical
   * resource id. Either `physicalResourceId` or `physicalResourceIdPath`
   * must be specified for onCreate or onUpdate calls.
   *
   * @default no path
   */
  readonly physicalResourceIdPath?: string;

  /**
   * The physical resource id of the custom resource for this call. Either
   * `physicalResourceId` or `physicalResourceIdPath` must be specified for
   * onCreate or onUpdate calls.
   *
   * @default no physical resource id
   */
  readonly physicalResourceId?: string;

  /**
   * The regex pattern to use to catch API errors. The `code` property of the
   * `Error` object will be tested against this pattern. If there is a match an
   * error will not be thrown.
   *
   * @default do not catch errors
   */
  readonly catchErrorPattern?: string;

  /**
   * API version to use for the service
   *
   * @see https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/locking-api-versions.html
   * @default use latest available API version
   */
  readonly apiVersion?: string;
}

export interface AwsCustomResourceProps {
  /**
   * The AWS SDK call to make when the resource is created.
   * At least onCreate, onUpdate or onDelete must be specified.
   *
   * @default the call when the resource is updated
   */
  readonly onCreate?: AwsSdkCall;

  /**
   * The AWS SDK call to make when the resource is updated
   *
   * @default no call
   */
  readonly onUpdate?: AwsSdkCall;

  /**
   * THe AWS SDK call to make when the resource is deleted
   *
   * @default no call
   */
  readonly onDelete?: AwsSdkCall;

  /**
   * The IAM policy statements to allow the different calls. Use only if
   * resource restriction is needed.
   *
   * @default extract the permissions from the calls
   */
  readonly policyStatements?: iam.PolicyStatement[];
}

export class AwsCustomResource extends cdk.Construct {
  private readonly customResource: CustomResource;

  constructor(scope: cdk.Construct, id: string, props: AwsCustomResourceProps) {
    super(scope, id);

    if (!props.onCreate && !props.onUpdate && !props.onDelete) {
      throw new Error('At least `onCreate`, `onUpdate` or `onDelete` must be specified.');
    }

    for (const call of [props.onCreate, props.onUpdate]) {
      if (call && !call.physicalResourceId && !call.physicalResourceIdPath) {
        throw new Error('Either `physicalResourceId` or `physicalResourceIdPath` must be specified for onCreate and onUpdate calls.');
      }
    }

    const provider = new lambda.SingletonFunction(this, 'Provider', {
      code: lambda.Code.asset(path.join(__dirname, 'aws-custom-resource-provider')),
      runtime: lambda.Runtime.NodeJS10x,
      handler: 'index.handler',
      uuid: '679f53fa-c002-430c-b0da-5b7982bd2287',
      lambdaPurpose: 'AWS'
    });

    if (props.policyStatements) {
      for (const statement of props.policyStatements) {
        provider.addToRolePolicy(statement);
      }
    } else { // Derive statements from AWS SDK calls
      for (const call of [props.onCreate, props.onUpdate, props.onDelete]) {
        if (call) {
          provider.addToRolePolicy(
            new iam.PolicyStatement()
              .addAction(awsSdkToIamAction(call.service, call.action))
              .addAllResources()
          );
        }
      }
    }

    this.customResource = new CustomResource(this, 'Resource', {
      resourceType: 'Custom::AWS',
      provider: CustomResourceProvider.lambda(provider),
      properties: {
        create: props.onCreate || props.onUpdate,
        update: props.onUpdate,
        delete: props.onDelete
      }
    });
  }

  /**
   * Returns response data for the AWS SDK call.
   * Example for S3 / listBucket : 'Buckets.0.Name'
   *
   * @param dataPath the path to the data
   */
  public getData(dataPath: string) {
    return this.customResource.getAtt(dataPath);
  }
}

/**
 * Transform SDK service/action to IAM action using metadata from aws-sdk module.
 * Example: CloudWatchLogs with putRetentionPolicy => logs:PutRetentionPolicy
 *
 * TODO: is this mapping correct for all services?
 */
function awsSdkToIamAction(service: string, action: string): string {
  const srv = service.toLowerCase();
  const iamService = awsSdkMetadata[srv].prefix || srv;
  const iamAction = action.charAt(0).toUpperCase() + action.slice(1);
  return `${iamService}:${iamAction}`;
}