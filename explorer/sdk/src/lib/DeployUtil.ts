/**
 * Util methods for making Deploy message
 *
 * @packageDocumentation
 */
import {
  Approval,
  Deploy,
  Signature
} from 'casperlabs-grpc/io/casperlabs/casper/consensus/consensus_pb';
import JSBI from 'jsbi';
import * as nacl from 'tweetnacl-ts';
import { ByteArray } from '../index';
import { Args, BigIntValue } from './Args';
import { protoHash } from './Contracts';

/**
 * Supported contract type
 */
export enum ContractType {
  WASM = 'WASM',
  Hash = 'Hash',
  Name = 'Name'
}

/**
 * Make Deploy message
 *
 * @param args session arguments
 * @param type the type of session contract, has to be {@link ContractType.WASM}
 * @param session the wasm code of session contract
 * @param paymentWasm the wasm code of payment contract, set it null if you want to use the standard payment contract
 * @param paymentAmount
 * @param accountPublicKeyHash The account public key hash that used to sign the Deploy.
 * @param dependencies  List of `Deploy.deploy_hash`s that must be executed in past blocks before this deploy can be executed.
 * @param entryPoint entry point of smart contract
 */
export function makeDeploy(
  args: Deploy.Arg[],
  type: ContractType.WASM,
  session: ByteArray,
  paymentWasm: ByteArray | null,
  paymentAmount: bigint | JSBI,
  accountPublicKeyHash: ByteArray,
  dependencies?: Uint8Array[]
): Deploy;

/**
 * Make Deploy message
 *
 * @param args session arguments
 * @param type the type of session contract, has to be {@link ContractType.Hash}
 * @param session the hash of session contract
 * @param paymentWasm the wasm code of payment contract, set it null if you want to use the standard payment contract
 * @param paymentAmount
 * @param accountPublicKeyHash The account public key hash that used to sign the Deploy.
 * @param dependencies  List of `Deploy.deploy_hash`s that must be executed in past blocks before this deploy can be executed.
 * @param entryPoint entry point of smart contract
 */
export function makeDeploy(
  args: Deploy.Arg[],
  type: ContractType.Hash,
  session: ByteArray,
  paymentWasm: ByteArray | null,
  paymentAmount: bigint | JSBI,
  accountPublicKey: ByteArray,
  dependencies: Uint8Array[],
  entryPoint: string
): Deploy;

/**
 * Makes Deploy message
 *
 * @param args session arguments
 * @param type the type of session contract, has to be {@link ContractType.Name}
 * @param sessionName the name of session contract
 * @param paymentWasm the wasm code of payment contract, set it null if you want to use the standard payment contract
 * @param paymentAmount
 * @param accountPublicKeyHash The account public key hash that used to sign the Deploy.
 * @param dependencies  List of `Deploy.deploy_hash`s that must be executed in past blocks before this deploy can be executed.
 * @param entryPoint entry point of smart contract
 */
export function makeDeploy(
  args: Deploy.Arg[],
  type: ContractType.Name,
  sessionName: string,
  paymentWasm: ByteArray | null,
  paymentAmount: bigint | JSBI,
  accountPublicKeyHash: ByteArray,
  dependencies: Uint8Array[],
  entryPoint: string
): Deploy;

/**
 * Makes Deploy message
 */
export function makeDeploy(
  args: Deploy.Arg[],
  type: ContractType,
  session: ByteArray | string,
  paymentWasm: ByteArray | null,
  paymentAmount: bigint | JSBI,
  accountPublicKeyHash: ByteArray,
  dependencies?: Uint8Array[],
  entryPoint?: string,
): Deploy {
  const sessionCode = new Deploy.Code();
  if (type === ContractType.WASM) {
    const wasmContract = new Deploy.Code.WasmContract();
    wasmContract.setWasm(session);
    sessionCode.setWasmContract(wasmContract);
  } else if (type === ContractType.Hash) {
    const storedContract = new Deploy.Code.StoredContract();
    storedContract.setContractHash(session);
    storedContract.setEntryPoint(entryPoint || "");
    sessionCode.setStoredContract(storedContract);
  } else {
    const storedContract = new Deploy.Code.StoredContract();
    storedContract.setName(session as string);
    storedContract.setEntryPoint(entryPoint || "")
    sessionCode.setStoredContract(storedContract);
  }
  sessionCode.setArgsList(args);

  if (paymentWasm === null) {
    paymentWasm = Buffer.from('');
  }
  const paymentContract = new Deploy.Code.WasmContract();
  paymentContract.setWasm(paymentWasm);
  const payment = new Deploy.Code();
  payment.setWasmContract(paymentContract);
  payment.setArgsList(Args(['amount', BigIntValue(paymentAmount)]));

  const body = new Deploy.Body();
  body.setSession(sessionCode);
  body.setPayment(payment);

  const header = new Deploy.Header();
  header.setAccountPublicKeyHash(accountPublicKeyHash);
  header.setTimestamp(new Date().getTime());
  header.setBodyHash(protoHash(body));
  // we will remove gasPrice eventually
  header.setGasPrice(1);
  header.setDependenciesList(dependencies ?? []);

  const deploy = new Deploy();
  deploy.setBody(body);
  deploy.setHeader(header);
  deploy.setDeployHash(protoHash(header));
  return deploy;
}

/**
 * Uses the provided key pair to sign the Deploy message
 *
 * @param deploy
 * @param signingKeyPair
 */
export const signDeploy = (
  deploy: Deploy,
  signingKeyPair: nacl.SignKeyPair
): Deploy => {
  const signature = new Signature();
  signature.setSigAlgorithm('ed25519');
  signature.setSig(
    nacl.sign_detached(deploy.getDeployHash_asU8(), signingKeyPair.secretKey)
  );

  const approval = new Approval();
  approval.setApproverPublicKey(signingKeyPair.publicKey);
  approval.setSignature(signature);

  deploy.setApprovalsList([approval]);

  return deploy;
};

/**
 * Sets the already generated Ed25519 signature for the Deploy message
 *
 * @param deploy
 * @param sig the Ed25519 signature
 * @param publicKey the public key used to generate the Ed25519 signature
 */
export const setSignature = (
  deploy: Deploy,
  sig: ByteArray,
  publicKey: ByteArray
): Deploy => {
  const signature = new Signature();
  signature.setSigAlgorithm('ed25519');
  signature.setSig(sig);

  const approval = new Approval();
  approval.setApproverPublicKey(publicKey);
  approval.setSignature(signature);

  deploy.setApprovalsList([approval]);

  return deploy;
};
