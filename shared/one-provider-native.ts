import type {OneProviderResourceReadGrant} from './one-provider-read';
import type {OneVaultBinding} from './one-vault';
import type {OneProviderAction,OneProviderErrorCode,OneProviderReceipt} from './one-provider';
export const ONE_PROVIDER_NATIVE_SCHEMA='agentlas.one-provider-native.v1' as const;
export type OneProviderNativeState='key-missing'|'key-saved'|'verification-required'|'verified'|'audio-ready'|'outcome-unknown'|'unavailable';
export interface OneProviderQuote {quoteId:string;currency:string;upperBoundMinor:number;payerId:string;consentRevision:string;expiresAt:number}
export interface OneProviderPrepared {
 schema:typeof ONE_PROVIDER_NATIVE_SCHEMA;commandId:string;bindingKey:string;operationId:string;
 action:OneProviderAction;quote:OneProviderQuote;
}
/** All fields mandatory; unavailable values are explicit null/empty. Main resolves current original command. */
export interface OneProviderBootstrap {
 schema:typeof ONE_PROVIDER_NATIVE_SCHEMA;state:OneProviderNativeState;commandId:string;bindingKey:string;
 binding:OneVaultBinding|null;credentialGeneration:number|null;accountLabel:string;roleLabel:string;
 permittedModels:Array<{id:string;label:string}>;permittedVoices:Array<{id:string;label:string}>;
 permittedTextRefs:Array<{ref:string;label:string;digest:string}>;
 quote:OneProviderQuote|null;retention:{enableProviderLogging:boolean;disclosure:string};
 activeOperation:OneProviderPrepared|null;receipt:OneProviderReceipt|null;
 /** Fresh SAME native read-core authority; never a dispatch or key-use grant. */
 resourceGrant:OneProviderResourceReadGrant|null;
 pinnedHost:{hostId:string;hostKeyId:string;publicKey:string;trustGeneration:number}|null;
 observedAt:number;expiresAt:number;errorCode:OneProviderErrorCode|null;
}
/** No secret, arbitrary text/endpoint/principal or renderer approval flag crosses this port. */
export interface OneProviderNativeAPI {
 bootstrap(input:{commandId:string}):Promise<OneProviderBootstrap>;
 prepare(input:{commandId:string;kind:'verify'|'tts';modelId:string;voiceId:string;textRef:string|null}):Promise<OneProviderPrepared>;
 /** Main must obtain fresh native owner grant, quote and cost approval immediately before bridge dispatch. */
 execute(input:{operationId:string}):Promise<OneProviderReceipt>;
 /** Exact same operation only; never redispatch an unknown paid effect. */
 status(input:{operationId:string}):Promise<OneProviderReceipt>;
 /** Main verifies signature, action/current authority, decoded WAV digest and manifest before native playback. */
 openAudio(input:{operationId:string;receiptDigest:string}):Promise<void>;
}
