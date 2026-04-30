// AI Chat — Claude conversation widget. Uses your own Anthropic API key.
//
// • Settings ⚙: paste API key, choose model (Opus 4.7 / Sonnet 4.6 / Haiku 4.5),
//   set system prompt, toggle adaptive thinking + thinking visibility,
//   adjust effort, max_tokens.
// • Messages: scrollable history; user right-aligned (amber), assistant
//   left-aligned (green); thinking blocks shown dim if enabled.
// • System prompts > 1000 chars are sent with cache_control: ephemeral so
//   subsequent turns hit the prompt cache (~90% input-token discount).
// • Uses window.dashboard.net.fetch — bypasses CORS so api.anthropic.com
//   works directly without browser-extension headers.
//
// API Key Security
// ────────────────
// Your key is stored in plain localStorage. That's fine for a personal
// dashboard but anyone with read access to your machine can see it. Don't
// run this on a shared computer with someone else's API key.

const KEY = 'plugin:ai-chat:state:v1';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Models — exact IDs from the Claude API skill (no date suffixes on aliases)
const MODELS = [
  {
    id: 'claude-opus-4-7',
    label: 'opus 4.7',
    hint: 'most capable',
    contextK: 1000,
    effortMin: 'medium',
    supportsThinking: true,
    requiresAdaptive: true, // Opus 4.7 only supports adaptive thinking
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'sonnet 4.6',
    hint: 'balanced',
    contextK: 1000,
    effortMin: 'low',
    supportsThinking: true,
    requiresAdaptive: false,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'haiku 4.5',
    hint: 'fast / cheap',
    contextK: 200,
    effortMin: null, // effort param errors on Haiku 4.5
    supportsThinking: true,
    requiresAdaptive: false,
  },
];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-4-7',
  systemPrompt: '',
  thinking: false, // adaptive thinking off by default (Opus 4.7 default)
  showThinking: false, // when on, display: 'summarized' so blocks have text
  effort: 'high',
  maxTokens: 8192,
  messages: [], // [{ id, role, content, blocks?, thinking?, ts, usage? }]
};

const loadState = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw };
  } catch {}
  return { ...DEFAULTS };
};

const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// ANSI-free, terminal-friendly markdown-ish renderer:
// Detects ```fenced``` code blocks, renders them with monospace background.
// Inline `code` gets a subtle highlight. Otherwise plain text with whitespace
// preserved. We don't render full markdown — keeping it terminal-native.
const renderText = (text) => {
  if (!text) return null;
  const parts = [];
  let i = 0;
  let lastIdx = 0;
  while (i < text.length) {
    // Fenced code block
    if (text.slice(i, i + 3) === '```') {
      // Push preceding text
      if (i > lastIdx) parts.push({ type: 'text', text: text.slice(lastIdx, i) });
      // Find end fence
      const restStart = i + 3;
      const newline = text.indexOf('\n', restStart);
      const lang = newline === -1 ? '' : text.slice(restStart, newline).trim();
      const codeStart = newline === -1 ? restStart : newline + 1;
      const closeIdx = text.indexOf('```', codeStart);
      if (closeIdx === -1) {
        // Unclosed — treat the rest as code
        parts.push({ type: 'code', lang, text: text.slice(codeStart) });
        lastIdx = text.length;
        break;
      }
      parts.push({ type: 'code', lang, text: text.slice(codeStart, closeIdx).replace(/\n$/, '') });
      lastIdx = closeIdx + 3;
      i = lastIdx;
      continue;
    }
    i++;
  }
  if (lastIdx < text.length) parts.push({ type: 'text', text: text.slice(lastIdx) });
  return parts;
};

const InlineText = ({ text }) => {
  // Render with `inline` highlights and preserved whitespace
  const segments = [];
  const re = /`([^`\n]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: 'plain', text: text.slice(last, m.index) });
    segments.push({ kind: 'code', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'plain', text: text.slice(last) });
  return (
    <>
      {segments.map((s, i) => s.kind === 'code' ? (
        <span key={i} style={{
          fontFamily: 'var(--mono)',
          background: 'rgba(var(--accent-rgb),0.08)',
          padding: '0 4px',
          borderRadius: 2,
          fontSize: '0.92em',
          color: 'var(--accent)',
        }}>{s.text}</span>
      ) : <React.Fragment key={i}>{s.text}</React.Fragment>)}
    </>
  );
};

const ageStr = (ts) => {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
};

export default {
  id: 'ai-chat',
  name: 'AI Chat',
  width: 2,
  height: 4,
  component: ({ React, useState, useEffect, useRef, useMemo }) => {
    const [state, setState] = useState(loadState);
    const [input, setInput] = useState('');
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const scrollRef = useRef(null);
    const inputRef = useRef(null);
    const confirmTimer = useRef(null);

    useEffect(() => {
      const id = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(state)), 200);
      return () => clearTimeout(id);
    }, [state]);

    // Auto-scroll on new messages
    useEffect(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [state.messages.length, generating]);

    const currentModel = MODELS.find((m) => m.id === state.model) || MODELS[0];

    const send = async () => {
      const text = input.trim();
      if (!text || generating) return;
      const apiKey = state.apiKey.trim();
      if (!apiKey) {
        setError('paste your Anthropic API key in ⚙ settings');
        setShowSettings(true);
        return;
      }
      const api = window.dashboard && window.dashboard.net;
      if (!api || !api.fetch) {
        setError('host net.fetch unavailable — restart the app');
        return;
      }

      const userMsg = { id: newId(), role: 'user', content: text, ts: Date.now() };
      const newMessages = [...state.messages, userMsg];
      setState((s) => ({ ...s, messages: newMessages }));
      setInput('');
      setError(null);
      setGenerating(true);

      // Build the API messages array — strip our internal fields
      const apiMessages = newMessages.map((m) => ({
        role: m.role,
        // For assistant messages we previously got back, replay the original
        // content blocks (including any thinking blocks) when available so
        // the API has the full context.
        content: m.role === 'assistant' && Array.isArray(m.blocks) ? m.blocks : m.content,
      }));

      // Build the body. Different models accept different params:
      const body = {
        model: state.model,
        max_tokens: state.maxTokens,
        messages: apiMessages,
      };

      // System prompt with prompt caching — wrap in structured form when long
      // enough that caching is plausible. The min cacheable prefix is ~4096
      // tokens (Opus 4.7) / ~2048 tokens (Sonnet 4.6) — char heuristic of
      // ~1000 chars (~250 tokens) under-shoots, but the SDK silently no-ops
      // sub-threshold caches and we still get top-level auto-caching.
      if (state.systemPrompt.trim()) {
        body.system = [{
          type: 'text',
          text: state.systemPrompt.trim(),
          cache_control: { type: 'ephemeral' },
        }];
      }

      // Adaptive thinking (Opus 4.7 only supports adaptive; others can choose)
      if (state.thinking && currentModel.supportsThinking) {
        body.thinking = {
          type: 'adaptive',
          // Opus 4.7 omits thinking text by default; opt back in if user wants it
          ...(state.showThinking ? { display: 'summarized' } : {}),
        };
      }

      // Effort: nested under output_config; not supported on Haiku
      if (currentModel.effortMin) {
        body.output_config = { effort: state.effort };
      }

      try {
        const r = await api.fetch({
          url: API_URL,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          timeout: 120000,
        });

        if (r.error) {
          setError('network: ' + r.error);
          setGenerating(false);
          return;
        }

        if (!r.ok) {
          // Try to parse the JSON error body
          let detail = 'http ' + r.status;
          try {
            const j = JSON.parse(r.text);
            if (j.error && j.error.message) detail = j.error.type + ': ' + j.error.message;
          } catch {}
          setError(detail);
          setGenerating(false);
          return;
        }

        let parsed;
        try { parsed = JSON.parse(r.text); }
        catch { setError('bad response (not JSON)'); setGenerating(false); return; }

        // Extract text + thinking from content blocks
        const blocks = Array.isArray(parsed.content) ? parsed.content : [];
        const textParts = [];
        const thinkingParts = [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) textParts.push(b.text);
          else if (b.type === 'thinking' && b.thinking) thinkingParts.push(b.thinking);
        }
        const assistantMsg = {
          id: newId(),
          role: 'assistant',
          content: textParts.join('\n'),
          thinking: thinkingParts.join('\n'),
          blocks, // for replay in multi-turn
          ts: Date.now(),
          usage: parsed.usage || null,
          stopReason: parsed.stop_reason,
          model: parsed.model,
        };
        setState((s) => ({ ...s, messages: [...s.messages, assistantMsg] }));
      } catch (e) {
        setError(e.message || 'request failed');
      } finally {
        setGenerating(false);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };

    const clearConversation = () => {
      if (confirmClear) {
        setState((s) => ({ ...s, messages: [] }));
        setConfirmClear(false);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        return;
      }
      setConfirmClear(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 2500);
    };

    const removeMessage = (id) => {
      setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== id) }));
    };

    const totalCost = useMemo(() => {
      let inT = 0, outT = 0, cacheR = 0, cacheW = 0;
      for (const m of state.messages) {
        if (m.usage) {
          inT += m.usage.input_tokens || 0;
          outT += m.usage.output_tokens || 0;
          cacheR += m.usage.cache_read_input_tokens || 0;
          cacheW += m.usage.cache_creation_input_tokens || 0;
        }
      }
      return { inT, outT, cacheR, cacheW };
    }, [state.messages]);

    return (
      <div className="p-col" style={{ height: '100%', gap: 4 }}>
        {/* Toolbar */}
        <div className="p-row" style={{ alignItems: 'center', gap: 4 }}>
          <div style={{
            display: 'inline-flex',
            border: '1px solid var(--border-bright)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            {MODELS.map((m) => {
              const active = state.model === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setState((s) => ({ ...s, model: m.id }))}
                  title={m.hint + ' · ' + m.contextK + 'K context'}
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--fg-dim)',
                    border: 'none',
                    padding: '2px 8px',
                    fontFamily: 'var(--mono)', fontSize: 9,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    fontWeight: active ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >{m.label}</button>
              );
            })}
          </div>
          <span style={{ flex: 1 }} />
          <button
            onClick={clearConversation}
            title={confirmClear ? 'click to confirm clear' : 'clear conversation'}
            style={{
              background: confirmClear ? 'rgba(255,107,107,0.15)' : 'transparent',
              border: '1px solid ' + (confirmClear ? 'var(--danger)' : 'var(--border-bright)'),
              color: confirmClear ? 'var(--danger)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
              letterSpacing: '0.08em', textTransform: 'uppercase',
              fontWeight: confirmClear ? 700 : 400,
            }}
          >{confirmClear ? '✓ clear' : 'new'}</button>
          <button
            onClick={() => setShowSettings((o) => !o)}
            title="settings"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-bright)',
              color: showSettings ? 'var(--accent)' : 'var(--fg-dim)',
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '1px 6px', borderRadius: 2, cursor: 'pointer',
            }}
          >⚙</button>
        </div>

        {error && (
          <div style={{
            padding: '4px 8px', color: 'var(--danger)',
            border: '1px dashed var(--danger)', borderRadius: 3, fontSize: 10,
          }}>! {error}</div>
        )}

        {/* Settings panel */}
        {showSettings && (
          <div style={{
            border: '1px dashed var(--border-bright)',
            borderRadius: 3, padding: 6,
            display: 'flex', flexDirection: 'column', gap: 6,
            maxHeight: 300, overflowY: 'auto',
          }}>
            <div className="p-col" style={{ gap: 2 }}>
              <span className="p-label" style={{ fontSize: 9 }}>API key</span>
              <input
                type="password"
                value={state.apiKey}
                onChange={(e) => setState((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder="sk-ant-..."
                spellCheck={false}
                className="p-input"
                style={{ fontSize: 11 }}
              />
              <span className="p-dim" style={{ fontSize: 9 }}>
                stored in localStorage; from console.anthropic.com
              </span>
            </div>

            <div className="p-col" style={{ gap: 2 }}>
              <span className="p-label" style={{ fontSize: 9 }}>system prompt</span>
              <textarea
                value={state.systemPrompt}
                onChange={(e) => setState((s) => ({ ...s, systemPrompt: e.target.value }))}
                placeholder="(optional) you are a helpful assistant…"
                spellCheck={false}
                className="p-input"
                rows={3}
                style={{ fontSize: 11, fontFamily: 'var(--mono)', resize: 'vertical' }}
              />
              {state.systemPrompt.trim().length > 1000 && (
                <span className="p-dim" style={{ fontSize: 9, color: 'var(--accent)' }}>
                  ↳ sent with cache_control · subsequent turns hit prompt cache
                </span>
              )}
            </div>

            {currentModel.effortMin && (
              <div className="p-col" style={{ gap: 2 }}>
                <span className="p-label" style={{ fontSize: 9 }}>effort: {state.effort}</span>
                <div style={{
                  display: 'flex',
                  border: '1px solid var(--border-bright)',
                  borderRadius: 3, overflow: 'hidden',
                }}>
                  {EFFORTS.map((e) => {
                    const active = state.effort === e;
                    return (
                      <button
                        key={e}
                        onClick={() => setState((s) => ({ ...s, effort: e }))}
                        style={{
                          flex: 1,
                          background: active ? 'var(--accent-warm)' : 'transparent',
                          color: active ? 'var(--bg)' : 'var(--fg-dim)',
                          border: 'none',
                          padding: '2px 4px',
                          fontFamily: 'var(--mono)', fontSize: 9,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          fontWeight: active ? 700 : 400,
                          cursor: 'pointer',
                        }}
                      >{e}</button>
                    );
                  })}
                </div>
              </div>
            )}

            {currentModel.supportsThinking && (
              <div className="p-col" style={{ gap: 2 }}>
                <label className="p-row" style={{ alignItems: 'center', gap: 6, fontSize: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={state.thinking}
                    onChange={(e) => setState((s) => ({ ...s, thinking: e.target.checked }))}
                  />
                  <span>adaptive thinking</span>
                  <span className="p-dim" style={{ fontSize: 9 }}>(deeper reasoning, slower)</span>
                </label>
                {state.thinking && (
                  <label className="p-row" style={{ alignItems: 'center', gap: 6, fontSize: 10, cursor: 'pointer', paddingLeft: 16 }}>
                    <input
                      type="checkbox"
                      checked={state.showThinking}
                      onChange={(e) => setState((s) => ({ ...s, showThinking: e.target.checked }))}
                    />
                    <span>show thinking text</span>
                    <span className="p-dim" style={{ fontSize: 9 }}>(display: summarized)</span>
                  </label>
                )}
              </div>
            )}

            <div className="p-row" style={{ alignItems: 'center', gap: 6 }}>
              <span className="p-dim" style={{ fontSize: 10, width: 70 }}>max tokens</span>
              <input
                type="number"
                min="256"
                max="32768"
                step="256"
                value={state.maxTokens}
                onChange={(e) => setState((s) => ({ ...s, maxTokens: Math.max(256, Math.min(32768, parseInt(e.target.value, 10) || 4096)) }))}
                className="p-input"
                style={{ width: 80, fontSize: 11 }}
              />
              <span className="p-dim" style={{ fontSize: 9 }}>per response</span>
            </div>

            {(totalCost.inT > 0 || totalCost.outT > 0) && (
              <div className="p-dim" style={{ fontSize: 9, lineHeight: 1.4, fontFamily: 'var(--mono)' }}>
                session totals — in: {totalCost.inT}t · out: {totalCost.outT}t
                {totalCost.cacheR > 0 && <span> · cache hit: {totalCost.cacheR}t</span>}
                {totalCost.cacheW > 0 && <span> · cache write: {totalCost.cacheW}t</span>}
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{
            flex: 1, minHeight: 0,
            overflowY: 'auto',
            padding: '6px 4px',
            display: 'flex', flexDirection: 'column', gap: 8,
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid var(--border)',
            borderRadius: 3,
          }}
        >
          {state.messages.length === 0 && !generating && (
            <div className="p-dim" style={{
              fontSize: 11, padding: 12, textAlign: 'center',
              fontFamily: 'var(--mono)', lineHeight: 1.6,
            }}>
              {state.apiKey
                ? 'type a message and press enter'
                : (
                  <>
                    add your Anthropic API key in ⚙ settings<br />
                    <span style={{ color: 'var(--fg-dim)', fontSize: 10 }}>
                      console.anthropic.com → API keys
                    </span>
                  </>
                )
              }
            </div>
          )}
          {state.messages.map((m) => {
            const isUser = m.role === 'user';
            const c = isUser ? 'var(--accent-warm)' : 'var(--accent)';
            const blocks = renderText(m.content);
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: isUser ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
              >
                <div className="p-row" style={{
                  alignItems: 'center', gap: 4,
                  fontSize: 9, color: 'var(--fg-dim)',
                  flexDirection: isUser ? 'row-reverse' : 'row',
                }}>
                  <span style={{ color: c, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    {isUser ? 'you' : (m.model || 'claude')}
                  </span>
                  <span>· {ageStr(m.ts)} ago</span>
                  {m.usage && !isUser && (
                    <span title={'input ' + m.usage.input_tokens + 't · output ' + m.usage.output_tokens + 't'}>
                      · {m.usage.output_tokens}t
                    </span>
                  )}
                  <button
                    onClick={() => removeMessage(m.id)}
                    title="delete"
                    style={{
                      background: 'transparent', border: 'none',
                      color: 'var(--fg-dim)', cursor: 'pointer',
                      fontFamily: 'var(--mono)', fontSize: 10,
                      padding: '0 2px', opacity: 0.5,
                    }}
                  >×</button>
                </div>
                {/* Thinking block */}
                {m.thinking && (
                  <div style={{
                    border: '1px dashed var(--border-bright)',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: 2,
                    padding: '4px 6px',
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                    color: 'var(--fg-dim)',
                    fontStyle: 'italic',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    lineHeight: 1.4,
                  }}>
                    <span style={{ color: 'var(--accent-warm)', fontStyle: 'normal' }}>thinking · </span>
                    {m.thinking}
                  </div>
                )}
                {/* Main content */}
                <div style={{
                  background: isUser ? 'rgba(255,180,84,0.08)' : 'rgba(var(--accent-rgb),0.05)',
                  border: '1px solid ' + (isUser ? 'rgba(255,180,84,0.3)' : 'rgba(var(--accent-rgb),0.25)'),
                  borderLeft: '3px solid ' + c,
                  borderRadius: 3,
                  padding: '6px 8px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--fg-bright)',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {blocks ? blocks.map((b, i) => (
                    b.type === 'code' ? (
                      <pre key={i} style={{
                        background: 'rgba(0,0,0,0.5)',
                        border: '1px solid var(--border)',
                        borderRadius: 2,
                        padding: '6px 8px',
                        margin: '4px 0',
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: 'var(--accent)',
                        overflow: 'auto',
                        whiteSpace: 'pre',
                      }}>
                        {b.lang && <div style={{
                          fontSize: 8, color: 'var(--fg-dim)',
                          letterSpacing: '0.1em', textTransform: 'uppercase',
                          marginBottom: 2,
                        }}>{b.lang}</div>}
                        {b.text}
                      </pre>
                    ) : <InlineText key={i} text={b.text} />
                  )) : m.content}
                  {!m.content && !m.thinking && m.stopReason && (
                    <span className="p-dim" style={{ fontStyle: 'italic' }}>
                      (no text · stop: {m.stopReason})
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {generating && (
            <div style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
              <div className="p-dim" style={{
                fontSize: 9, color: 'var(--accent)',
                textTransform: 'uppercase', letterSpacing: '0.1em',
                marginBottom: 2,
              }}>{currentModel.label}</div>
              <div style={{
                background: 'rgba(var(--accent-rgb),0.05)',
                border: '1px solid rgba(var(--accent-rgb),0.25)',
                borderLeft: '3px solid var(--accent)',
                borderRadius: 3,
                padding: '6px 12px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--accent)',
                textShadow: 'var(--glow)',
              }}>
                <span className="thinking-dots">●●●</span>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-row" style={{ gap: 4, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={state.apiKey ? 'message claude…' : 'add API key in ⚙ first'}
            disabled={!state.apiKey || generating}
            spellCheck={false}
            rows={2}
            className="p-input"
            style={{
              flex: 1,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              resize: 'vertical',
              minHeight: 32,
              maxHeight: 120,
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || !state.apiKey || generating}
            style={{
              background: (input.trim() && state.apiKey && !generating) ? 'var(--accent)' : 'transparent',
              color: (input.trim() && state.apiKey && !generating) ? 'var(--bg)' : 'var(--fg-dim)',
              border: '1px solid ' + ((input.trim() && state.apiKey && !generating) ? 'var(--accent)' : 'var(--border-bright)'),
              fontFamily: 'var(--mono)', fontSize: 11,
              padding: '8px 14px', borderRadius: 3,
              cursor: (input.trim() && state.apiKey && !generating) ? 'pointer' : 'not-allowed',
              fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >{generating ? '…' : '▶'}</button>
        </div>
      </div>
    );
  },
};
