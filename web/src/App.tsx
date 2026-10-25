import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyMandate,
  breakEnvelope,
  chat,
  connectWallet,
  getState,
  getVerify,
  getWallet,
  injected,
  prepareMandate,
  setRunning,
  signTypedData,
  submitMandate,
  switchToChain,
  tick,
  walletChainId,
  type Record as Decision,
  type State,
  type VerifyResult,
} from './api';
import { bps, clock, countdown, num, short } from './format';
import { Card, Chip, Hash, Meter, Sparkline } from './components/ui';

const OUTCOME_TONE: Record<string, 'ok' | 'danger' | 'muted' | 'warn'> = {
  FILLED: 'ok',
  BREACH_REVERTED: 'danger',
  REFUSED: 'muted',
  ERROR: 'warn',
};

const OUTCOME_LABEL: Record<string, string> = {
  FILLED: 'FILLED',
  BREACH_REVERTED: 'REVERTED',
  REFUSED: 'REFUSED',
  ERROR: 'ERROR',
};

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [selected, setSelected] = useState<Decision | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [chatReply, setChatReply] = useState<{ reply: string; patch: any } | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const walletIsOwner = !!wallet && !!owner && wallet.toLowerCase() === owner.toLowerCase();

  const flash = (tone: 'ok' | 'danger', text: string) => {
    setToast({ tone, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 9000);
  };

  const refresh = async () => {
    try {
      const [next, proof] = await Promise.all([getState(), getVerify().catch(() => null)]);
      setState(next);
      if (proof) setVerify(proof);
      if (!selected && next.records.length) setSelected(next.records[0]);
    } catch (error) {
      flash('danger', (error as Error).message);
    }
  };

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state?.records?.length && !selected) setSelected(state.records[0]);
  }, [state, selected]);

  // who may sign the mandate, and whether the wallet agrees with the desk about the chain
  useEffect(() => {
    getWallet()
      .then((info) => setOwner(info.owner))
      .catch(() => undefined);

    const provider = injected();
    if (!provider) return;

    provider
      .request({ method: 'eth_accounts' })
      .then(async (accounts) => {
        const list = (accounts as string[]) ?? [];
        if (list.length) {
          setWallet(list[0]);
          setWalletChain(await walletChainId().catch(() => null));
        }
      })
      .catch(() => undefined);

    provider.on?.('accountsChanged', (accounts) => {
      const list = (accounts as string[]) ?? [];
      setWallet(list[0] ?? null);
    });
    provider.on?.('chainChanged', (chain) => setWalletChain(Number.parseInt(String(chain), 16)));
  }, []);

  const connect = async () => {
    setBusy('wallet');
    try {
      const account = await connectWallet();
      setWallet(account);
      const info = await getWallet();
      setOwner(info.owner);
      const chain = await walletChainId();
      setWalletChain(chain);
      if (chain !== info.chainId) {
        await switchToChain(info.chainId);
        setWalletChain(info.chainId);
      }
      flash(
        'ok',
        account.toLowerCase() === info.owner.toLowerCase()
          ? 'Wallet connected. This address owns the envelope.'
          : 'Wallet connected, but this address is not the envelope owner.'
      );
    } catch (error) {
      flash('danger', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runTick = async () => {
    setBusy('tick');
    try {
      const result = await tick({});
      await refresh();
      if (result?.skipped) {
        flash('ok', 'A cycle is already in flight.');
      } else {
        if (result?.record) setSelected(result.record);
        flash('ok', `Cycle complete: ${OUTCOME_LABEL[result.record.outcome] ?? result.record.outcome}`);
      }
    } catch (error) {
      flash('danger', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runBreak = async () => {
    setBusy('break');
    try {
      const result = await breakEnvelope(400);
      await refresh();
      if (result.error) {
        flash('danger', `Envelope held: ${result.error.message}`);
      } else {
        flash('ok', 'The order went through, which should not happen.');
      }
    } catch (error) {
      flash('danger', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sendChat = async () => {
    if (!message.trim()) return;
    setBusy('chat');
    try {
      const result = await chat(message.trim());
      setChatReply(result);
    } catch (error) {
      flash('danger', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const signPatch = async () => {
    if (!chatReply) return;
    setBusy('sign');
    try {
      if (wallet && walletIsOwner) {
        const prepared = await prepareMandate(chatReply.patch);
        const signature = await signTypedData(wallet, prepared.typedData);
        const result = await submitMandate(prepared.mandate, signature);
        await refresh();
        setChatReply(null);
        setMessage('');
        flash('ok', `Mandate v${result.mandate?.nonce} signed by your wallet and installed`);
      } else {
        const result = await applyMandate(chatReply.patch);
        await refresh();
        setChatReply(null);
        setMessage('');
        flash('ok', `Mandate v${result.mandate?.nonce} signed and installed`);
      }
    } catch (error) {
      flash('danger', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleRun = async () => {
    if (!state) return;
    setBusy('run');
    try {
      await setRunning(!state.agent.running);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const drawdownBps = useMemo(() => {
    if (!state) return 0;
    const day = Number(state.position.dayEquity);
    const now = Number(state.position.equityQuote);
    if (!day || now >= day) return 0;
    return Math.round(((day - now) / day) * 10_000);
  }, [state]);

  if (!state) {
    return (
      <div className="boot">
        <div className="boot-mark">ENVELOPE</div>
        <div className="boot-line">connecting to the desk…</div>
      </div>
    );
  }

  const { mandate, position, market, ledger, agent, deployment } = state;
  const quoteScale = 10 ** deployment.quoteDecimals;
  const equity = Number(position.equityQuote) / quoteScale;
  const dayEquity = Number(position.dayEquity) / quoteScale;
  const positionQuote = Number(position.baseValueQuote) / quoteScale;
  const maxNotional = Number(mandate.maxNotionalQuote) / quoteScale;
  const verified = verify?.ok ?? false;
  const lastFilled = state.records.find((r) => r.outcome === 'FILLED');
  const lastOrderNotional = lastFilled ? (lastFilled.preimage.sizePct / 100) * maxNotional : 0;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◤
          </span>
          <div>
            <div className="brand-name">Envelope</div>
            <div className="brand-tag">a trading desk that cannot break its mandate</div>
          </div>
        </div>

        <div className="top-right">
          <Chip tone="muted">
            {deployment.baseSymbol}/{deployment.quoteSymbol} · chain {deployment.chainId}
          </Chip>
          <Chip tone={verified ? 'ok' : 'danger'}>
            {verified ? `chain verified · ${ledger.count} links` : 'chain unverified'}
          </Chip>
          {!wallet ? (
            <button className="btn" onClick={connect} disabled={busy === 'wallet'}>
              {busy === 'wallet' ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : (
            <Chip tone={walletIsOwner ? 'ok' : 'warn'}>
              {walletIsOwner ? `owner ${short(wallet, 4, 4)}` : `wallet ${short(wallet, 4, 4)} · not owner`}
            </Chip>
          )}
          {wallet && walletChain != null && walletChain !== deployment.chainId ? (
            <Chip tone="danger">wrong network</Chip>
          ) : null}
          <span className="mandate-nonce mono">mandate v{mandate.nonce}</span>
          <button className={`btn ${agent.running ? 'btn-live' : ''}`} onClick={toggleRun} disabled={busy === 'run'}>
            <span className={`dot ${agent.running ? 'on' : ''}`} />
            {agent.running ? 'Agent running' : 'Agent paused'}
          </button>
        </div>
      </header>

      <div className="strip">
        <div className="stat">
          <span className="stat-label">Equity</span>
          <span className="stat-value mono">{num(equity, 4)}</span>
          <span className="stat-sub mono">{deployment.quoteSymbol}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Price</span>
          <span className="stat-value mono">{num(market.price, 6)}</span>
          <span className={`stat-sub mono ${market.imbalancePct < 0 ? 'down' : 'up'}`}>
            {market.imbalancePct > 0 ? '+' : ''}
            {market.imbalancePct.toFixed(2)}% vs ref
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Exposure</span>
          <span className="stat-value mono">{bps(position.positionBps)}</span>
          <span className="stat-sub mono">cap {bps(mandate.maxPositionBps)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Ledger</span>
          <span className="stat-value mono">{ledger.count}</span>
          <span className="stat-sub mono">head {short(ledger.head, 4, 4)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Last fill</span>
          <span className="stat-value mono">{lastFilled ? clock(lastFilled.ts) : '—'}</span>
          <span className="stat-sub mono">{lastFilled ? `${lastFilled.preimage.action} ${lastFilled.preimage.sizePct}%` : 'no fills yet'}</span>
        </div>
        <div className="stat spark-stat">
          <span className="stat-label">Pool</span>
          <Sparkline series={market.series} height={40} />
        </div>
      </div>

      <main className="grid">
        <div className="col col-left">
          <Card
            title="Risk envelope"
            meta={<span className="mono">expires in {countdown(mandate.expiry)}</span>}
          >
            <div className="meters">
              <Meter label="Exposure" value={position.positionBps / 100} cap={mandate.maxPositionBps / 100} hint={`${num(positionQuote, 4)} of ${num(equity, 4)} ${deployment.quoteSymbol}`} />
              <Meter label="Daily drawdown" value={drawdownBps / 100} cap={mandate.maxDailyLossBps / 100} hint={`day opened at ${num(dayEquity, 4)}`} />
              <Meter label="Trades this hour" value={position.tradesThisHour} cap={mandate.maxTradesPerHour} />
              <Meter label="Last order" value={lastOrderNotional} cap={maxNotional} hint={`ceiling ${num(maxNotional, 4)} ${deployment.quoteSymbol} per trade`} />
            </div>

            <div className="kv">
              <div>
                <span>Max slippage</span>
                <b className="mono">{bps(mandate.maxSlippageBps)}</b>
              </div>
              <div>
                <span>Executor</span>
                <b className="mono">{short(mandate.executor, 6, 4)}</b>
              </div>
              <div>
                <span>Desk contract</span>
                <b className="mono">{short(deployment.trader, 6, 4)}</b>
              </div>
              <div>
                <span>Owner of record</span>
                <b className="mono">{owner ? short(owner, 6, 4) : '—'}</b>
              </div>
            </div>

            <button className="btn btn-danger wide" onClick={runBreak} disabled={busy === 'break'}>
              {busy === 'break' ? 'Sending oversized order…' : 'Ask for 4× the mandate'}
            </button>
            <p className="fineprint">Submits a real order that breaches the mandate. The chain rejects it, the desk does not.</p>
          </Card>

          <Card title="Cycle" meta={<span className="mono">{agent.model}</span>}>
            <div className="cycle">
              <button className="btn wide" onClick={runTick} disabled={busy === 'tick'}>
                {busy === 'tick' ? 'Reasoning…' : 'Run one cycle'}
              </button>
              <p className="fineprint">
                Snapshot the pool, ask the model, size the order, submit it, anchor the decision. Loop is {agent.running ? 'live' : 'paused'} every{' '}
                {Math.round(agent.intervalMs / 1000)}s.
              </p>
              {agent.lastError ? <p className="error-line">{agent.lastError}</p> : null}
            </div>
          </Card>

          <Card title="Console" meta={<span className="mono">natural language</span>}>
            <div className="console">
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && sendChat()}
                placeholder="be more aggressive with size, but never more than 8 trades an hour"
              />
              <button className="btn" onClick={sendChat} disabled={busy === 'chat' || !message.trim()}>
                {busy === 'chat' ? '…' : 'Interpret'}
              </button>
            </div>
            {chatReply ? (
              <div className="proposal">
                <p>{chatReply.reply}</p>
                <pre className="mono">{JSON.stringify(chatReply.patch, null, 1)}</pre>
                <button className="btn btn-accent wide" onClick={signPatch} disabled={busy === 'sign'}>
                  {busy === 'sign'
                    ? 'Signing…'
                    : walletIsOwner
                      ? 'Sign in wallet and install'
                      : 'Sign and install mandate'}
                </button>
                <p className="fineprint">
                  {walletIsOwner
                    ? 'Your wallet signs the mandate. The agent can only propose it.'
                    : 'The agent cannot raise its own limits. Only a signature can.'}
                </p>
              </div>
            ) : null}
          </Card>
        </div>

        <div className="col col-mid">
          <Card
            title="Decision record"
            meta={<span className="mono">{state.records.length} entries</span>}
          >
            <div className="feed">
              {state.records.length === 0 ? (
                <div className="empty">No decisions yet. Run a cycle.</div>
              ) : (
                state.records.map((record) => (
                  <button
                    key={record.id}
                    className={`row ${selected?.id === record.id ? 'row-selected' : ''}`}
                    onClick={() => setSelected(record)}
                  >
                    <span className={`row-bar ${OUTCOME_TONE[record.outcome] ?? 'muted'}`} />
                    <span className="row-time mono">{clock(record.ts)}</span>
                    <Chip tone={OUTCOME_TONE[record.outcome] ?? 'muted'}>{OUTCOME_LABEL[record.outcome] ?? record.outcome}</Chip>
                    <span className="row-action mono">
                      {record.preimage.action} {record.preimage.sizePct > 0 ? `${record.preimage.sizePct}%` : ''}
                    </span>
                    <span className="row-thesis">{record.preimage.thesis}</span>
                    <span className="row-hash mono">{short(record.decisionHash, 4, 4)}</span>
                  </button>
                ))
              )}
            </div>
          </Card>
        </div>

        <div className="col col-right">
          {selected ? (
            <Card
              title="Receipt"
              meta={
                <span className="mono">
                  {OUTCOME_LABEL[selected.outcome]} · {clock(selected.ts)}
                </span>
              }
            >
              <div className="receipt">
                <div className="receipt-head">
                  <Chip tone={OUTCOME_TONE[selected.outcome] ?? 'muted'}>{OUTCOME_LABEL[selected.outcome]}</Chip>
                  <span className="receipt-action mono">
                    {selected.preimage.action}
                    {selected.preimage.sizePct > 0 ? ` · ${selected.preimage.sizePct}%` : ''}
                  </span>
                  <span className="receipt-model mono">{selected.model}</span>
                </div>

                <p className="thesis">{selected.preimage.thesis}</p>

                {selected.error ? (
                  <div className="breach">
                    <span className="breach-label">on-chain rejection</span>
                    <code className="mono">{selected.error.message}</code>
                  </div>
                ) : null}

                <div className="receipt-grid">
                  <div>
                    <span>price</span>
                    <b className="mono">{num(selected.preimage.price, 6)}</b>
                  </div>
                  <div>
                    <span>imbalance</span>
                    <b className="mono">{selected.preimage.imbalancePct.toFixed(2)}%</b>
                  </div>
                  <div>
                    <span>confidence</span>
                    <b className="mono">{selected.preimage.confidence.toFixed(2)}</b>
                  </div>
                  <div>
                    <span>latency</span>
                    <b className="mono">{selected.latencyMs}ms</b>
                  </div>
                </div>

                <div className="hash-stack">
                  <div>
                    <span>decision</span>
                    <Hash value={selected.decisionHash} />
                  </div>
                  <div>
                    <span>reasoning</span>
                    <Hash value={selected.preimage.reasoningHash} />
                  </div>
                  <div>
                    <span>transaction</span>
                    <Hash value={selected.txHash ?? 'not anchored'} />
                  </div>
                </div>

                <button className="link-btn" onClick={() => setShowReasoning((v) => !v)}>
                  {showReasoning ? 'hide model reasoning' : 'show model reasoning'}
                </button>
                {showReasoning ? <pre className="reasoning mono">{selected.reasoning || 'no reasoning returned'}</pre> : null}

                <details className="preimage">
                  <summary>decision preimage (hashed, not stored on-chain)</summary>
                  <pre className="mono">{JSON.stringify(selected.preimage, null, 1)}</pre>
                </details>
              </div>
            </Card>
          ) : (
            <Card title="Receipt">
              <div className="empty">Select a decision.</div>
            </Card>
          )}

          <Card title="Proof of edge" meta={<span className="mono">{verified ? 'verified' : 'unverified'}</span>}>
            <div className="proof">
              <div className="proof-row">
                <span>on-chain head</span>
                <Hash value={short(verify?.onChainHead, 8, 6)} />
              </div>
              <div className="proof-row">
                <span>recomputed</span>
                <Hash value={short(verify?.recomputedHead, 8, 6)} />
              </div>
              <div className="proof-row">
                <span>links</span>
                <b className="mono">{verify?.count ?? 0}</b>
              </div>
            </div>
            <p className="fineprint">
              Every link is recomputed from its parts. A broken link means the record was reordered or back-filled.
            </p>
          </Card>
        </div>
      </main>

      {toast ? <div className={`toast ${toast.tone}`}>{toast.text}</div> : null}
    </div>
  );
}
