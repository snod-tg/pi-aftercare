import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import type { AftercareBackend } from '../domain/backend.js';
import type { Actor } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';

const DocumentSchema = Type.Object({
  id: Type.String({ minLength: 1 }), merchantId: Type.String({ minLength: 1 }), policyVersion: Type.String({ minLength: 1 }),
  title: Type.String(), source: Type.String(), effectiveFrom: Type.String(), effectiveTo: Type.Union([Type.String(), Type.Null()]),
  chunks: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
});
export type PolicyDocument = Static<typeof DocumentSchema>;
function tokens(text: string) {
  const parts = text.toLowerCase().match(/[a-z0-9_-]+|\p{Script=Han}+/gu) ?? [];
  return parts.flatMap(part => /^[\p{Script=Han}]+$/u.test(part)
    ? (part.length === 1 ? [part] : Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2))) : [part]);
}
export class PolicyRetriever {
  readonly documents: PolicyDocument[];
  constructor(documents: PolicyDocument[]) {
    if (!Check(Type.Array(DocumentSchema), documents)) throw new Error('政策文档格式无效');
    const ids = new Set<string>();
    for (const doc of documents) {
      if (!Number.isFinite(Date.parse(doc.effectiveFrom)) || (doc.effectiveTo !== null && (!Number.isFinite(Date.parse(doc.effectiveTo)) || Date.parse(doc.effectiveTo) <= Date.parse(doc.effectiveFrom)))) throw new Error('政策生效时间无效');
      const key = `${doc.merchantId}:${doc.id}`;
      if (ids.has(key) || new Set(doc.chunks.map(c => c.id)).size !== doc.chunks.length) throw new Error('政策文档或分块标识重复');
      ids.add(key);
    }
    this.documents = structuredClone(documents);
  }
  search(query: string, merchantId: string, policyVersion: string, now: Date, limit = 3) {
    if (!query.trim() || query.length > 1000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new DomainError('INVALID_QUERY', '查询需为1–1000字符，条数需在1–5之间');
    const terms = [...new Set(tokens(query))];
    const candidates = this.documents.filter(doc => doc.merchantId === merchantId && doc.policyVersion === policyVersion && Date.parse(doc.effectiveFrom) <= now.getTime() && (doc.effectiveTo === null || now.getTime() < Date.parse(doc.effectiveTo)))
      .flatMap(doc => doc.chunks.map(chunk => ({ doc, chunk, terms: tokens(`${doc.title} ${chunk.text}`) })));
    const average = candidates.reduce((sum, chunk) => sum + chunk.terms.length, 0) / (candidates.length || 1);
    const df = new Map(terms.map(term => [term, candidates.filter(chunk => chunk.terms.includes(term)).length]));
    return candidates.map(candidate => {
      let score = 0;
      for (const term of terms) {
        const tf = candidate.terms.filter(t => t === term).length;
        if (!tf) continue;
        const frequency = df.get(term)!;
        const idf = Math.log(1 + (candidates.length - frequency + 0.5) / (frequency + 0.5));
        score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * candidate.terms.length / average));
      }
      return { ...candidate, score };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || `${a.doc.id}#${a.chunk.id}`.localeCompare(`${b.doc.id}#${b.chunk.id}`)).slice(0, limit).map(({ doc, chunk, score }) => ({
      citation: `${doc.id}#${chunk.id}`, documentId: doc.id, chunkId: chunk.id, title: doc.title,
      source: doc.source, policyVersion: doc.policyVersion, effectiveFrom: doc.effectiveFrom, effectiveTo: doc.effectiveTo,
      text: chunk.text, score: Number(score.toFixed(6)), contentHash: createHash('sha256').update(chunk.text).digest('hex'),
    }));
  }
}
let defaultRetriever: PolicyRetriever | undefined;
export function loadPolicyRetriever() {
  return defaultRetriever ??= new PolicyRetriever(JSON.parse(readFileSync(new URL('../../data/policies/demo.json', import.meta.url), 'utf8')) as PolicyDocument[]);
}
export async function searchPolicy(service: AftercareBackend, actor: Actor, input: { orderId: string; query: string; limit?: number }, retriever = loadPolicyRetriever(), now = new Date()) {
  const policy = await service.getPolicy(actor, input.orderId);
  const hits = retriever.search(input.query, actor.merchantId, policy.version, now, input.limit ?? 3);
  return { query: input.query, policyVersion: policy.version, retrievedAt: now.toISOString(), trust: 'untrusted_reference_text', hits,
    message: hits.length ? '引用仅作政策解释依据；业务规则、金额和权限仍由业务工具校验。' : '未检索到当前有效版本的相关条款；不能据此判断没有限制，请查询结构化政策或转人工。' };
}
