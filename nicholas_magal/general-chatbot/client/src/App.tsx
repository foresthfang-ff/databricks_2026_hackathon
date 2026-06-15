import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, useAnalyticsQuery, useServingInvoke } from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { Bot, Copy, Database, RotateCcw, Search, Send, Sparkles, UserRound } from 'lucide-react';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  grounded?: boolean;
}

interface GroundingJob {
  id: string;
  question: string;
  history: ChatMessage[];
}

interface ChoiceLike {
  message?: {
    content?: unknown;
  };
  delta?: {
    content?: unknown;
  };
  text?: unknown;
}

interface ChatResponseLike {
  choices?: ChoiceLike[];
  output_text?: unknown;
  content?: unknown;
}

interface FacilityGroundingRow {
  facility_id: string | null;
  canonical_name: string | null;
  facility_type: string | null;
  operator_type: string | null;
  city: string | null;
  state_region: string | null;
  postal_code: string | null;
  address_full: string | null;
  contacts: string | null;
  specialties: string | null;
  procedures: string | null;
  gold_confidence_score: number | string | null;
  specialty_confidence: number | string | null;
  procedure_confidence: number | string | null;
  specialty_evidence_count: number | string | null;
  has_center_of_excellence: number | string | null;
  has_inpatient_support: number | string | null;
  has_outpatient_support: number | string | null;
  requires_special_equipment: number | string | null;
  match_score: number | string | null;
}

const resultLimit = 8;

const initialMessages: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content:
      'Hi. Ask me about Indian healthcare facilities, specialties, procedures, locations, or contacts. I will answer from the configured healthcare facility tables.',
  },
];

const examples = [
  'Find cardiology hospitals in Mumbai with contact details.',
  'Which facilities mention hip replacement surgery near Coimbatore?',
  'Look for pediatric services in Uttar Pradesh.',
];

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createMessage(role: ChatRole, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: createId(),
    role,
    content,
    ...extra,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unrenderable value]';
  }
}

function extractAssistantText(data: unknown): string {
  if (!isRecord(data)) return stringifyUnknown(data);

  const response = data as ChatResponseLike;
  const firstChoice = response.choices?.[0];
  const choiceText =
    firstChoice?.message?.content ?? firstChoice?.delta?.content ?? firstChoice?.text;

  const content = choiceText ?? response.output_text ?? response.content;
  const text = stringifyUnknown(content).trim();

  return text || stringifyUnknown(data);
}

function boolText(value: number | string | null) {
  return Number(value ?? 0) > 0 ? 'yes' : 'no';
}

function compactFacilityContext(rows: FacilityGroundingRow[]) {
  return rows.map((row, index) => ({
    rank: index + 1,
    facility_id: row.facility_id,
    name: row.canonical_name,
    type: row.facility_type,
    operator: row.operator_type,
    location: [row.city, row.state_region, row.postal_code].filter(Boolean).join(', '),
    address: row.address_full,
    contacts: row.contacts,
    specialties: row.specialties,
    procedures: row.procedures,
    confidence: {
      facility: Number(row.gold_confidence_score ?? 0),
      specialty: Number(row.specialty_confidence ?? 0),
      procedure: Number(row.procedure_confidence ?? 0),
      match: Number(row.match_score ?? 0),
    },
    evidence: {
      specialty_count: Number(row.specialty_evidence_count ?? 0),
      center_of_excellence: boolText(row.has_center_of_excellence),
      inpatient_support: boolText(row.has_inpatient_support),
      outpatient_support: boolText(row.has_outpatient_support),
      special_equipment: boolText(row.requires_special_equipment),
    },
  }));
}

function buildGroundedPrompt(question: string, rows: FacilityGroundingRow[]) {
  const context = JSON.stringify(compactFacilityContext(rows), null, 2);
  return [
    'Answer the user using only the healthcare facility context below.',
    'Be concise, cite facility names, mention relevant specialties/procedures/locations/contacts, and say when evidence is limited.',
    'Do not invent facility facts that are not in the context.',
    '',
    `User question: ${question}`,
    '',
    `Facility context:\n${context}`,
  ].join('\n');
}

function recentModelMessages(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.id !== 'welcome')
    .slice(-6)
    .map((message) => ({ role: message.role, content: message.content }));
}

function isFacilityRows(value: unknown): value is FacilityGroundingRow[] {
  return Array.isArray(value);
}

interface GroundingRunnerProps {
  job: GroundingJob;
  onComplete: (jobId: string, rows: FacilityGroundingRow[]) => void;
  onError: (jobId: string, error: string) => void;
}

function GroundingRunner({ job, onComplete, onError }: GroundingRunnerProps) {
  const params = useMemo(
    () => ({
      query: sql.string(job.question),
      resultLimit: sql.number(resultLimit),
    }),
    [job.question]
  );
  const query = useAnalyticsQuery('facility_grounding', params);
  const completedRef = useRef(false);

  useEffect(() => {
    if (completedRef.current || query.loading) return;

    if (query.error) {
      completedRef.current = true;
      onError(job.id, query.error);
      return;
    }

    if (query.data) {
      completedRef.current = true;
      onComplete(job.id, isFacilityRows(query.data) ? query.data : []);
    }
  }, [job.id, onComplete, onError, query.data, query.error, query.loading]);

  return null;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [composer, setComposer] = useState('');
  const [lastCopiedId, setLastCopiedId] = useState<string | null>(null);
  const [groundingJob, setGroundingJob] = useState<GroundingJob | null>(null);
  const [groundingLoading, setGroundingLoading] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const servingRequest = useMemo(() => ({ messages: [] }), []);
  const { invoke, loading: servingLoading, error: servingError } = useServingInvoke(servingRequest);
  const busy = servingLoading || groundingLoading;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  function startFacilitySearch(question: string, history = messages) {
    setGroundingLoading(true);
    setGroundingJob({
      id: createId(),
      question,
      history,
    });
  }

  async function completeGroundedAnswer(jobId: string, rows: FacilityGroundingRow[]) {
    const job = groundingJob;
    if (!job || job.id !== jobId) return;

    setGroundingJob(null);
    setGroundingLoading(false);

    if (rows.length === 0) {
      setMessages((current) => [
        ...current,
        createMessage(
          'assistant',
          'I could not find matching facility evidence in the configured tables. Try a more specific specialty, procedure, city, state, facility name, or contact detail.',
          { grounded: true }
        ),
      ]);
      return;
    }

    const result = await invoke({
      messages: [
        ...recentModelMessages(job.history),
        { role: 'user', content: buildGroundedPrompt(job.question, rows) },
      ],
      max_tokens: 1100,
      temperature: 0.4,
    });

    if (!result) return;

    setMessages((current) => [
      ...current,
      createMessage('assistant', extractAssistantText(result), { grounded: true }),
    ]);
  }

  function failGroundedAnswer(jobId: string, error: string) {
    if (!groundingJob || groundingJob.id !== jobId) return;
    setGroundingJob(null);
    setGroundingLoading(false);
    setMessages((current) => [
      ...current,
      createMessage('assistant', `I could not query the facility grounding tables: ${error}`),
    ]);
  }

  function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = composer.trim();
    if (!content || busy) return;

    const userMessage = createMessage('user', content);
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setComposer('');
    startFacilitySearch(content, nextMessages);
  }

  function resetChat() {
    setMessages(initialMessages);
    setComposer('');
    setLastCopiedId(null);
    setGroundingJob(null);
    setGroundingLoading(false);
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(message.content);
    setLastCopiedId(message.id);
    window.setTimeout(() => setLastCopiedId(null), 1400);
  }

  return (
    <main className="app-shell">
      {groundingJob && (
        <GroundingRunner
          key={groundingJob.id}
          job={groundingJob}
          onComplete={(jobId, rows) => void completeGroundedAnswer(jobId, rows)}
          onError={failGroundedAnswer}
        />
      )}

      <section className="chat-workspace" aria-label="Grounded facility chatbot">
        <header className="chat-header">
          <div>
            <div className="eyebrow">Databricks App</div>
            <h1>Facility Chatbot</h1>
            <p>Healthcare facility chat grounded in Unity Catalog tables and Databricks Model Serving.</p>
          </div>
          <div className="header-actions">
            <div className="endpoint-pill" aria-label="Grounding data status">
              <Database size={16} aria-hidden="true" />
              Facility Tables
            </div>
            <div className="endpoint-pill" aria-label="Serving endpoint status">
              <Sparkles size={16} aria-hidden="true" />
              Model Serving
            </div>
            <Button type="button" variant="outline" onClick={resetChat}>
              <RotateCcw size={16} aria-hidden="true" />
              Reset
            </Button>
          </div>
        </header>

        <div className="chat-layout">
          <aside className="prompt-panel" aria-label="Example prompts">
            <h2>Try a Facility Prompt</h2>
            <div className="example-list">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="example-button"
                  onClick={() => setComposer(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </aside>

          <section className="conversation-panel" aria-label="Conversation">
            <div className="transcript" aria-live="polite">
              {messages.map((message) => (
                <article key={message.id} className={`message-row ${message.role}`}>
                  <div className="message-avatar" aria-hidden="true">
                    {message.role === 'assistant' ? <Bot size={17} /> : <UserRound size={17} />}
                  </div>
                  <div className="message-bubble">
                    <div className="message-meta">
                      <span>{message.role === 'assistant' ? 'Assistant' : 'You'}</span>
                      <div className="message-tools">
                        {message.grounded && (
                          <span className="grounded-tag">
                            <Search size={13} aria-hidden="true" />
                            Grounded
                          </span>
                        )}
                        {message.role === 'assistant' && message.id !== 'welcome' && (
                          <button
                            type="button"
                            className="copy-button"
                            onClick={() => void copyMessage(message)}
                            aria-label="Copy assistant response"
                            title="Copy response"
                          >
                            <Copy size={14} aria-hidden="true" />
                            {lastCopiedId === message.id ? 'Copied' : 'Copy'}
                          </button>
                        )}
                      </div>
                    </div>
                    <p>{message.content}</p>
                  </div>
                </article>
              ))}

              {busy && (
                <article className="message-row assistant">
                  <div className="message-avatar" aria-hidden="true">
                    <Bot size={17} />
                  </div>
                  <div className="message-bubble">
                    <div className="message-meta">
                      <span>Assistant</span>
                    </div>
                    <div className="typing-indicator" aria-label="Assistant is thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </article>
              )}

              {servingError && (
                <div className="error-banner" role="alert">
                  {String(servingError)}
                </div>
              )}
              <div ref={transcriptEndRef} />
            </div>

            <form className="composer" onSubmit={submitMessage}>
              <label htmlFor="chat-composer">Message</label>
              <div className="composer-row">
                <textarea
                  id="chat-composer"
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  placeholder="Ask about facilities, specialties, procedures, locations, or contacts..."
                  rows={3}
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submitMessage();
                    }
                  }}
                />
                <Button type="submit" disabled={busy || !composer.trim()} aria-label="Send message">
                  <Send size={16} aria-hidden="true" />
                  Send
                </Button>
              </div>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}
