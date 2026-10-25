import { CONFIG } from './config.js';

export type Proposal = {
  action: 'BUY' | 'SELL' | 'HOLD';
  sizePct: number;
  confidence: number;
  thesis: string;
  riskFlags: string[];
};

export type LlmResult = {
  proposal: Proposal;
  reasoning: string;
  raw: string;
  model: string;
  tokens: number;
  latencyMs: number;
  usedFallback: boolean;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const extractJson = (text: string): any | null => {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {}
  const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const first = direct.indexOf('{');
  const last = direct.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(direct.slice(first, last + 1));
    } catch {}
  }
  return null;
};

/**
 * Deterministic fallback so the trading loop never stalls when inference is unavailable.
 * It is deliberately dumb: it only reacts to a pool imbalance, and it is labelled as
 * fallback in every recorded decision so the ledger never hides that no model ran.
 */
export const fallbackProposal = (imbalancePct: number): Proposal => {
  const edge = Math.abs(imbalancePct);
  if (edge < 1.5) {
    return {
      action: 'HOLD',
      sizePct: 0,
      confidence: 0.2,
      thesis: `Pool is balanced within ${edge.toFixed(2)} percent, no trade edge. Deterministic fallback policy.`,
      riskFlags: ['model_unavailable'],
    };
  }
  return {
    action: imbalancePct > 0 ? 'SELL' : 'BUY',
    sizePct: clamp(edge, 4, 18),
    confidence: 0.3,
    thesis: `Pool imbalance of ${imbalancePct.toFixed(2)} percent, mean-reversion fallback policy.`,
    riskFlags: ['model_unavailable'],
  };
};

export const reason = async (system: string, user: string, fallback: Proposal): Promise<LlmResult> => {
  const started = Date.now();

  if (!CONFIG.particle.apiKey) {
    return {
      proposal: fallback,
      reasoning: 'No Particle key configured. Deterministic fallback used.',
      raw: '',
      model: 'fallback',
      tokens: 0,
      latencyMs: 0,
      usedFallback: true,
    };
  }

  try {
    const res = await fetch(`${CONFIG.particle.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CONFIG.particle.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.particle.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: CONFIG.particle.maxTokens,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      throw new Error(`particle ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const payload: any = await res.json();
    const choice = payload.choices?.[0];
    const content: string = choice?.message?.content ?? '';
    const reasoning: string = choice?.message?.reasoning_content ?? '';
    const parsed = extractJson(content);

    if (!parsed) throw new Error('model did not return parseable JSON');

    const action = String(parsed.action ?? 'HOLD').toUpperCase();
    const proposal: Proposal = {
      action: action === 'BUY' || action === 'SELL' ? action : 'HOLD',
      sizePct: clamp(Number(parsed.sizePct ?? 0), 0, 100),
      confidence: clamp(Number(parsed.confidence ?? 0), 0, 1),
      thesis: String(parsed.thesis ?? '').slice(0, 600),
      riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags.map(String).slice(0, 6) : [],
    };

    return {
      proposal,
      reasoning,
      raw: content,
      model: payload.model ?? CONFIG.particle.model,
      tokens: payload.usage?.total_tokens ?? 0,
      latencyMs: Date.now() - started,
      usedFallback: false,
    };
  } catch (error) {
    return {
      proposal: fallback,
      reasoning: `Inference failed: ${(error as Error).message}. Deterministic fallback used.`,
      raw: '',
      model: 'fallback',
      tokens: 0,
      latencyMs: Date.now() - started,
      usedFallback: true,
    };
  }
};
