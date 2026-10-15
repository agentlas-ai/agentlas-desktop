import {evaluateWorkPrograms,validateWorkOracle,getWorkEvaluationIdentity} from '../business/employee-agent-work-evaluator';
import {parseWorkProgram,workDigest} from '../business/employee-agent-work-semantics';
import type {HistoryEvolutionEvaluation} from '../../shared/one-history-evolution';
/** Actual finite executor only. Oracle input is a separately reviewed immutable artifact. */
export function evaluateHistoryWork(input:{before:string;after:string;oracle:unknown;oracleAcceptanceId:string;proposalDigest:string;envelopeDigest:string;draftDigest:string}){
 const oracle=validateWorkOracle(input.oracle),result=evaluateWorkPrograms(parseWorkProgram(input.before),parseWorkProgram(input.after),oracle,input);
 const evaluation:HistoryEvolutionEvaluation={draftDigest:input.draftDigest,envelopeDigest:input.envelopeDigest,oracleId:oracle.oracleId,oracleRevision:oracle.revision,fixtureDigest:workDigest(oracle),resultDigest:result.resultDigest,passed:result.passed,isolated:true,networkAccess:false,providerCalls:0};
 return {evaluation,artifact:{...result,schema:'agentlas.personal.history-work-evaluation.v1',evaluator:getWorkEvaluationIdentity()}};
}
