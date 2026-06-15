import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Skeleton, useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import {
  BadgeCheck,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  FileText,
  HeartPulse,
  MapPin,
  MessageSquareText,
  Phone,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Sparkles,
  Star,
  UserRound,
} from 'lucide-react';

interface ReferralSummary {
  facility_count: number | string;
  high_confidence_count: number | string;
  contactable_count: number | string;
  district_context_count: number | string;
  average_evidence_score: number | string;
}

interface ReferralCandidate {
  facility_id: string;
  name: string | null;
  facility_type: string | null;
  operator_type: string | null;
  city: string | null;
  district_name: string | null;
  state_name: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  official_phone: unknown;
  official_website: unknown;
  evidence_score: number;
  evidence_confidence: string;
  record_quality: string;
  capability_match_score: number;
  location_match_score: number;
  referral_score: number;
  district_need_score: number | null;
  district_context_available: boolean;
  evidence_description: unknown;
  evidence_specialties: unknown;
  evidence_procedures: unknown;
  evidence_equipment: unknown;
  evidence_capabilities: unknown;
  evidence_source_urls: unknown;
  page_update_date: unknown;
}

interface ReferralCase {
  case_id: string;
  title: string;
  patient_context: string;
  care_need: string;
  location: string;
  urgency: string;
  status: string;
  updated_at: string;
}

interface CaseDraft {
  title: string;
  patientContext: string;
  careNeed: string;
  location: string;
  urgency: 'routine' | 'soon' | 'urgent';
}

type ChatStep = 'careNeed' | 'location' | 'urgency' | 'context' | 'review' | 'results';

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
}

const initialDraft: CaseDraft = {
  title: '',
  patientContext: '',
  careNeed: '',
  location: '',
  urgency: 'soon',
};

const initialMessages: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    text: 'I’ll help find a defensible referral option from the available facility evidence. What care, specialty, procedure, or equipment is needed?',
  },
];

const numberFormat = new Intl.NumberFormat('en-US', { notation: 'compact' });

function asNumber(value: number | string | undefined) {
  return Number(value ?? 0);
}

function toDisplayText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => toDisplayText(item))
      .filter(Boolean)
      .join(', ');
    return joined || null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unrenderable value]';
  }
}

function excerpt(value: unknown, max = 250) {
  const text = toDisplayText(value);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function firstUrl(value: unknown) {
  const text = toDisplayText(value);
  if (!text) return null;
  return text.match(/https?:\/\/[^\s"',\]]+/)?.[0] ?? null;
}

function websiteHref(value: unknown) {
  const text = toDisplayText(value);
  if (!text) return '#';
  return text.startsWith('http') ? text : `https://${text}`;
}

function urgencyLabel(value: string) {
  if (value === 'urgent') return 'Urgent coordination';
  if (value === 'routine') return 'Routine planning';
  return 'Needs coordination soon';
}

function createMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: `${Date.now()}-${Math.random()}`, role, text };
}

export default function App() {
  const [draft, setDraft] = useState<CaseDraft>(initialDraft);
  const [step, setStep] = useState<ChatStep>('careNeed');
  const [composer, setComposer] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [activeCase, setActiveCase] = useState<ReferralCase | null>(null);
  const [savedCases, setSavedCases] = useState<ReferralCase[]>([]);
  const [selected, setSelected] = useState<ReferralCandidate | null>(null);
  const [shortlisted, setShortlisted] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [agentBrief, setAgentBrief] = useState('');
  const [agentMode, setAgentMode] = useState<'model' | 'deterministic-fallback' | null>(null);
  const [saving, setSaving] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const summaryParams = useMemo(() => ({}), []);
  const summaryQuery = useAnalyticsQuery('referral_summary', summaryParams);
  const searchParams = useMemo(
    () => ({
      careNeed: sql.string(activeCase?.care_need ?? ''),
      location: sql.string(activeCase?.location ?? ''),
      confidenceWeight: sql.int(100),
      accessWeight: sql.int(100),
      needWeight: sql.int(70),
      limit: sql.int(12),
    }),
    [activeCase]
  );
  const searchQuery = useAnalyticsQuery('referral_search', searchParams, { autoStart: Boolean(activeCase) });

  const summaryRows = summaryQuery.data as unknown as ReferralSummary[] | null;
  const candidateRows = searchQuery.data as unknown as ReferralCandidate[] | null;
  const summary = summaryRows?.[0] ?? null;
  const candidates = useMemo(() => candidateRows ?? [], [candidateRows]);

  useEffect(() => {
    fetch('/api/referrals/cases')
      .then((response) => response.json() as Promise<ReferralCase[]>)
      .then(setSavedCases)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setSelected(candidates[0] ?? null);
    setShortlisted(new Set());
    setAgentBrief('');
    setAgentMode(null);
  }, [candidates]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, step, searchQuery.loading, candidates.length, agentBrief]);

  async function requestChatReply(
    previousStep: ChatStep,
    nextStep: ChatStep,
    nextDraft: CaseDraft,
    userAnswer: string,
    recentMessages: ChatMessage[],
    fallback: string
  ) {
    const response = await fetch('/api/referrals/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previousStep,
        step: nextStep,
        userAnswer,
        draft: nextDraft,
        messages: recentMessages.slice(-12),
      }),
    });
    if (!response.ok) return fallback;
    const result = (await response.json()) as { reply?: string };
    return result.reply?.trim() || fallback;
  }

  async function addLlmExchange(answer: string, nextStep: ChatStep, nextDraft: CaseDraft, fallback: string, previousStep = step) {
    const userMessage = createMessage('user', answer);
    const recentMessages = [...messages, userMessage];
    setMessages((current) => [...current, userMessage]);
    setComposer('');
    setChatting(true);
    try {
      const reply = await requestChatReply(previousStep, nextStep, nextDraft, answer, recentMessages, fallback);
      setMessages((current) => [...current, createMessage('assistant', reply)]);
    } catch {
      setMessages((current) => [...current, createMessage('assistant', fallback)]);
    } finally {
      setChatting(false);
    }
  }

  async function submitComposer() {
    const answer = composer.trim();
    if (!answer || chatting) return;
    setError(null);

    if (step === 'careNeed') {
      const nextDraft = { ...draft, careNeed: answer };
      setDraft(nextDraft);
      setStep('location');
      await addLlmExchange(
        answer,
        'location',
        nextDraft,
        `Got it: ${answer}. Where should I search? Enter a city, district, state, or 6-digit pincode, or search across India.`
      );
      return;
    }
    if (step === 'location') {
      const nextDraft = { ...draft, location: answer };
      setDraft(nextDraft);
      setStep('urgency');
      await addLlmExchange(answer, 'urgency', nextDraft, `I’ll look for ${nextDraft.careNeed || 'that referral need'} near ${answer}. How quickly does this need to be coordinated?`);
      return;
    }
    if (step === 'context') {
      const nextDraft = { ...draft, patientContext: answer };
      setDraft(nextDraft);
      setStep('review');
      await addLlmExchange(answer, 'review', nextDraft, `I have enough information to search for ${nextDraft.careNeed}${nextDraft.location ? ` near ${nextDraft.location}` : ' across India'}. Review the request below, then start the evidence search.`);
    }
  }

  async function skipLocation() {
    if (chatting) return;
    const nextDraft = { ...draft, location: '' };
    setDraft(nextDraft);
    setStep('urgency');
    await addLlmExchange('Search across India', 'urgency', nextDraft, `I’ll look for ${nextDraft.careNeed || 'that referral need'} across India. How quickly does this need to be coordinated?`);
  }

  async function chooseUrgency(urgency: CaseDraft['urgency']) {
    if (chatting) return;
    const nextDraft = { ...draft, urgency };
    setDraft(nextDraft);
    setStep('context');
    await addLlmExchange(
      urgencyLabel(urgency),
      'context',
      nextDraft,
      `${urgencyLabel(urgency)} noted. Are there any non-identifying constraints I should consider, such as mobility, language, transfer timing, or equipment?`
    );
  }

  async function skipContext() {
    if (chatting) return;
    const nextDraft = { ...draft, patientContext: '' };
    setDraft(nextDraft);
    setStep('review');
    await addLlmExchange('No additional constraints', 'review', nextDraft, `I have enough information to search for ${nextDraft.careNeed}${nextDraft.location ? ` near ${nextDraft.location}` : ' across India'}. Review the request below, then start the evidence search.`);
  }

  async function createCase(overrides: Partial<CaseDraft> = {}) {
    const input = { ...draft, ...overrides };
    if (!input.careNeed.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/referrals/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...input,
          title: input.title.trim() || `${input.careNeed.trim()} referral`,
        }),
      });
      if (!response.ok) throw new Error('Could not save the referral case.');
      const created = (await response.json()) as ReferralCase;
      setDraft(input);
      setActiveCase(created);
      setSavedCases((current) => [created, ...current]);
      setStep('results');
      const userMessage = createMessage('user', 'Search for referral options');
      setMessages((current) => [...current, userMessage]);
      setChatting(true);
      const fallback = `I’m checking the available facility evidence for "${input.careNeed}"${input.location ? ` near ${input.location}` : ' across India'}. I will only recommend records with enough matching evidence.`;
      const reply = await requestChatReply('review', 'results', input, 'Search for referral options', [...messages, userMessage], fallback);
      setMessages((current) => [...current, createMessage('assistant', reply)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the referral case.');
    } finally {
      setChatting(false);
      setSaving(false);
    }
  }

  async function recordDecision(candidate: ReferralCandidate, action: 'shortlist' | 'remove' | 'selected') {
    if (!activeCase) return;
    const response = await fetch(`/api/referrals/cases/${activeCase.case_id}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        facilityId: candidate.facility_id,
        facilityName: candidate.name || 'Unnamed facility',
        action,
        note,
        score: Number(candidate.referral_score),
      }),
    });
    if (!response.ok) {
      setError('Could not persist this referral decision.');
      return;
    }
    setShortlisted((current) => {
      const next = new Set(current);
      if (action === 'remove') next.delete(candidate.facility_id);
      else next.add(candidate.facility_id);
      return next;
    });
    setMessages((current) => [
      ...current,
      createMessage(
        'assistant',
        action === 'selected'
          ? `${candidate.name || 'This facility'} was recorded as the selected referral. Verify capability and acceptance directly before handoff.`
          : `${candidate.name || 'This facility'} was ${action === 'remove' ? 'removed from' : 'added to'} the shortlist.`
      ),
    ]);
    setNote('');
  }

  async function generateBrief() {
    if (!activeCase || candidates.length === 0) return;
    setExplaining(true);
    setError(null);
    try {
      const response = await fetch('/api/referrals/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          case: {
            title: activeCase.title,
            patientContext: activeCase.patient_context,
            careNeed: activeCase.care_need,
            location: activeCase.location,
            urgency: activeCase.urgency,
          },
          candidates: candidates.slice(0, 3),
        }),
      });
      if (!response.ok) throw new Error('The referral brief agent is temporarily unavailable.');
      const result = (await response.json()) as {
        explanation: string;
        mode: 'model' | 'deterministic-fallback';
      };
      setAgentBrief(result.explanation);
      setAgentMode(result.mode);
      setMessages((current) => [
        ...current,
        createMessage('assistant', 'I generated a coordinator brief using only the displayed facility evidence. Review it below before contacting a facility.'),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not generate a referral brief.');
    } finally {
      setExplaining(false);
    }
  }

  function resetConversation() {
    setDraft(initialDraft);
    setActiveCase(null);
    setStep('careNeed');
    setComposer('');
    setMessages(initialMessages);
    setSelected(null);
    setShortlisted(new Set());
    setAgentBrief('');
    setAgentMode(null);
    setError(null);
  }

  function openSavedCase(item: ReferralCase) {
    setActiveCase(item);
    setDraft({
      title: item.title,
      patientContext: item.patient_context,
      careNeed: item.care_need,
      location: item.location,
      urgency: item.urgency as CaseDraft['urgency'],
    });
    setMessages([
      createMessage('assistant', 'I reopened this saved referral case. I’ll rerun the evidence search using the saved criteria.'),
      createMessage('user', `${item.care_need}${item.location ? ` near ${item.location}` : ' across India'}`),
    ]);
    setStep('results');
  }

  return (
    <div className="min-h-screen bg-[#F6F4EF] text-[#0B2026]">
      <header className="border-b border-black/10 bg-[#0B2026] text-white">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#FF3621]"><HeartPulse className="h-5 w-5" /></div>
            <div>
              <p className="text-sm font-semibold">Referral Copilot</p>
              <p className="text-xs text-white/50">A guided, evidence-grounded conversation</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-white/60 sm:flex">
            <BadgeCheck className="h-4 w-4 text-emerald-400" /> Databricks governed workflow
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] gap-5 px-5 py-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:px-8">
        <aside className="rounded-[22px] border border-black/10 bg-white p-4 shadow-sm">
          <Button className="w-full bg-[#FF3621] text-white hover:bg-[#E62F1C]" onClick={resetConversation}>
            <Plus className="mr-2 h-4 w-4" /> New conversation
          </Button>
          <p className="eyebrow mt-6">Saved referrals</p>
          <div className="mt-3 space-y-2">
            {savedCases.length === 0 && <p className="px-2 text-xs leading-5 text-black/45">No saved referrals yet.</p>}
            {savedCases.map((item) => (
              <button
                type="button"
                key={item.case_id}
                onClick={() => openSavedCase(item)}
                className={`w-full rounded-xl border px-3 py-3 text-left ${
                  activeCase?.case_id === item.case_id ? 'border-[#FF3621]/40 bg-[#FFF0ED]' : 'border-black/8 hover:bg-black/[0.025]'
                }`}
              >
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="mt-1 truncate text-xs text-black/45">{item.location || 'All India'} · {urgencyLabel(item.urgency)}</p>
              </button>
            ))}
          </div>
          <div className="mt-6 rounded-xl bg-[#F6F4EF] p-3 text-xs leading-5 text-black/55">
            <ShieldAlert className="mb-2 h-4 w-4 text-[#C32817]" />
            Do not enter names or patient identifiers. This tool supports coordination, not diagnosis or treatment.
          </div>
        </aside>

        <div className="min-w-0">
          <section className="referral-hero overflow-hidden rounded-[26px] bg-[#0B2026] px-6 py-7 text-white md:px-9">
            <div className="relative z-10 max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-white/75">
                <Sparkles className="h-3.5 w-3.5 text-[#FF8A78]" /> Asks before it recommends
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-[-0.045em] md:text-5xl">{"Let's find the right next call."}</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                The copilot gathers the referral need step by step, searches cited facility claims, and says plainly when the data cannot support a match.
              </p>
            </div>
          </section>

          <section className="-mt-3 grid gap-3 px-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Referral-ready facilities" value={summary?.facility_count} loading={summaryQuery.loading} />
            <MetricCard label="High evidence coverage" value={summary?.high_confidence_count} loading={summaryQuery.loading} />
            <MetricCard label="Contactable facilities" value={summary?.contactable_count} loading={summaryQuery.loading} />
            <MetricCard label="Average evidence score" value={summary ? `${asNumber(summary.average_evidence_score).toFixed(0)}/100` : undefined} loading={summaryQuery.loading} raw />
          </section>

          {error && (
            <div className="mt-5 flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
              <CircleAlert className="h-5 w-5 text-amber-700" /> {error}
            </div>
          )}

          <section className="chat-shell mt-6 overflow-hidden rounded-[26px] border border-black/10 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-black/8 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#0B2026] text-white"><Bot className="h-4 w-4" /></div>
                <div><p className="text-sm font-semibold">Referral intake</p><p className="text-xs text-black/45">Evidence-grounded assistant</p></div>
              </div>
              <Button size="sm" variant="outline" onClick={resetConversation}><RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restart</Button>
            </div>

            <div className="chat-transcript space-y-4 overflow-y-auto bg-[#FAF9F6] p-5 md:p-7">
              {messages.map((message) => <ChatBubble key={message.id} message={message} />)}

              {step === 'urgency' && (
                <AssistantAction>
                  <QuickReply onClick={() => void chooseUrgency('routine')}>Routine planning</QuickReply>
                  <QuickReply onClick={() => void chooseUrgency('soon')}>Coordinate soon</QuickReply>
                  <QuickReply onClick={() => void chooseUrgency('urgent')}>Urgent coordination</QuickReply>
                </AssistantAction>
              )}

              {step === 'review' && (
                <AssistantAction>
                  <div className="w-full rounded-xl border border-black/10 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-black/40">Search criteria</p>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <SummaryItem label="Care needed" value={draft.careNeed} />
                      <SummaryItem label="Location" value={draft.location || 'Search across India'} />
                      <SummaryItem label="Urgency" value={urgencyLabel(draft.urgency)} />
                      <SummaryItem label="Constraints" value={draft.patientContext || 'None provided'} />
                    </dl>
                    <Button className="mt-4 w-full bg-[#0B2026] text-white hover:bg-[#17363D]" onClick={() => void createCase()} disabled={saving}>
                      {saving ? 'Saving and searching...' : 'Search cited facility evidence'} <Sparkles className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                </AssistantAction>
              )}

              {step === 'results' && (
                <ConversationResults
                  activeCase={activeCase}
                  candidates={candidates}
                  loading={searchQuery.loading}
                  queryError={searchQuery.error}
                  selected={selected}
                  shortlisted={shortlisted}
                  note={note}
                  agentBrief={agentBrief}
                  agentMode={agentMode}
                  explaining={explaining}
                  onSelect={setSelected}
                  onShortlist={(candidate) => void recordDecision(candidate, shortlisted.has(candidate.facility_id) ? 'remove' : 'shortlist')}
                  onDecision={(candidate) => void recordDecision(candidate, 'selected')}
                  onNoteChange={setNote}
                  onGenerateBrief={() => void generateBrief()}
                  onSearchAllLocations={() => void createCase({ location: '' })}
                  onRestart={resetConversation}
                />
              )}
              <div ref={chatEndRef} />
            </div>

            {(step === 'careNeed' || step === 'location' || step === 'context') && (
              <div className="border-t border-black/8 bg-white p-4">
                <div className="flex gap-2">
                  <Input
                    aria-label={step === 'careNeed' ? 'Required care or capability' : step === 'location' ? 'Referral location' : 'Referral constraints'}
                    value={composer}
                    placeholder={
                      step === 'careNeed'
                        ? 'e.g. neonatal intensive care with ventilator support'
                        : step === 'location'
                          ? 'e.g. Bengaluru, Karnataka, or 560001'
                          : 'Non-identifying constraints only'
                    }
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void submitComposer(); }}
                  />
                  <Button aria-label="Send answer" className="bg-[#FF3621] text-white hover:bg-[#E62F1C]" onClick={() => void submitComposer()} disabled={!composer.trim()}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                {(step === 'location' || step === 'context') && (
                  <button type="button" className="mt-2 text-xs font-medium text-[#C32817] hover:underline" onClick={() => { void (step === 'location' ? skipLocation() : skipContext()); }}>
                    {step === 'location' ? 'Search across India instead' : 'No additional constraints'}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const assistant = message.role === 'assistant';
  return (
    <div className={`flex items-end gap-2 ${assistant ? 'justify-start' : 'justify-end'}`}>
      {assistant && <span className="chat-avatar bg-[#0B2026] text-white"><Bot className="h-4 w-4" /></span>}
      <div className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-6 ${assistant ? 'rounded-bl-md border border-black/8 bg-white text-black/70' : 'rounded-br-md bg-[#FF3621] text-white'}`}>
        {message.text}
      </div>
      {!assistant && <span className="chat-avatar bg-[#FFE7E2] text-[#C32817]"><UserRound className="h-4 w-4" /></span>}
    </div>
  );
}

function AssistantAction({ children }: { children: React.ReactNode }) {
  return <div className="ml-10 flex max-w-3xl flex-wrap gap-2">{children}</div>;
}

function QuickReply({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <Button variant="outline" className="rounded-full bg-white" onClick={onClick}>{children}</Button>;
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-black/40">{label}</dt><dd className="mt-1 font-medium text-black/75">{value}</dd></div>;
}

function ConversationResults({
  activeCase,
  candidates,
  loading,
  queryError,
  selected,
  shortlisted,
  note,
  agentBrief,
  agentMode,
  explaining,
  onSelect,
  onShortlist,
  onDecision,
  onNoteChange,
  onGenerateBrief,
  onSearchAllLocations,
  onRestart,
}: {
  activeCase: ReferralCase | null;
  candidates: ReferralCandidate[];
  loading: boolean;
  queryError: string | null;
  selected: ReferralCandidate | null;
  shortlisted: Set<string>;
  note: string;
  agentBrief: string;
  agentMode: 'model' | 'deterministic-fallback' | null;
  explaining: boolean;
  onSelect: (candidate: ReferralCandidate) => void;
  onShortlist: (candidate: ReferralCandidate) => void;
  onDecision: (candidate: ReferralCandidate) => void;
  onNoteChange: (value: string) => void;
  onGenerateBrief: () => void;
  onSearchAllLocations: () => void;
  onRestart: () => void;
}) {
  if (loading) {
    return <AssistantAction><div className="grid w-full gap-3 md:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-44 rounded-2xl" />)}</div></AssistantAction>;
  }
  if (queryError) {
    return <AssistantAction><div className="w-full rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-900">{queryError}</div></AssistantAction>;
  }
  if (candidates.length === 0) {
    return (
      <AssistantAction>
        <div className="w-full rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex gap-3"><CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div>
            <h3 className="font-semibold text-amber-950">I cannot make a defensible match from the available evidence.</h3>
            <p className="mt-2 text-sm leading-6 text-amber-900/75">
              No facility record had enough care-term overlap{activeCase?.location ? ` within “${activeCase.location}”` : ''}. This does not mean the service is unavailable. It means this dataset does not support the claim strongly enough.
            </p>
            <ul className="mt-3 space-y-1 text-xs leading-5 text-amber-900/70">
              <li>Try a broader clinical capability or common synonym.</li>
              <li>Remove the location constraint to search all India records.</li>
              <li>Use a manual referral directory or phone verification when evidence is absent.</li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              {activeCase?.location && <Button size="sm" onClick={onSearchAllLocations}>Search all locations</Button>}
              <Button size="sm" variant="outline" onClick={onRestart}>Change the care need</Button>
            </div>
          </div></div>
        </div>
      </AssistantAction>
    );
  }

  const top = candidates[0];
  const confidenceCaution = top.evidence_confidence === 'High'
    ? 'The source record is comparatively complete, but current availability still requires confirmation.'
    : `The leading record has ${top.evidence_confidence.toLowerCase()} evidence confidence, so treat it as a lead rather than a confirmed referral.`;

  return (
    <div className="space-y-5">
      <ChatBubble message={createMessage('assistant', `I found ${candidates.length} evidence-backed option${candidates.length === 1 ? '' : 's'}. ${top.name || 'The first facility'} ranks first with a ${Number(top.capability_match_score).toFixed(0)}% care-term match. ${confidenceCaution}`)} />
      <AssistantAction>
        <div className="w-full">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-black/40">Ranked referral evidence</p>
            <Button size="sm" variant="outline" onClick={onGenerateBrief} disabled={explaining}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5 text-[#FF3621]" /> {explaining ? 'Reviewing evidence...' : 'Generate handoff brief'}
            </Button>
          </div>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,.75fr)]">
            <div className="space-y-3">
              {candidates.map((candidate, index) => (
                <CandidateCard
                  key={candidate.facility_id}
                  candidate={candidate}
                  rank={index + 1}
                  selected={selected?.facility_id === candidate.facility_id}
                  shortlisted={shortlisted.has(candidate.facility_id)}
                  onSelect={() => onSelect(candidate)}
                  onShortlist={() => onShortlist(candidate)}
                />
              ))}
            </div>
            <EvidencePanel candidate={selected} note={note} onNoteChange={onNoteChange} onSelect={() => { if (selected) onDecision(selected); }} />
          </div>
        </div>
      </AssistantAction>
      {agentBrief && (
        <AssistantAction>
          <div className="w-full rounded-2xl border border-[#FF3621]/20 bg-[#FFF4F1] p-5">
            <p className="eyebrow">Coordinator handoff</p>
            <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-black/75">{agentBrief}</div>
            <p className="mt-4 text-xs font-medium text-black/45">
              {agentMode === 'model' ? 'Generated from only the displayed candidate evidence.' : 'Deterministic evidence fallback used because model synthesis was unavailable.'}
            </p>
          </div>
        </AssistantAction>
      )}
    </div>
  );
}

function MetricCard({ label, value, loading, raw = false }: { label: string; value?: number | string; loading: boolean; raw?: boolean }) {
  return (
    <div className="relative z-10 rounded-2xl border border-black/8 bg-white px-5 py-4 shadow-lg shadow-black/5">
      {loading ? <Skeleton className="mb-2 h-7 w-20" /> : <p className="text-2xl font-semibold">{raw ? value : numberFormat.format(asNumber(value))}</p>}
      <p className="text-xs font-medium text-black/45">{label}</p>
    </div>
  );
}

function CandidateCard({ candidate, rank, selected, shortlisted, onSelect, onShortlist }: {
  candidate: ReferralCandidate; rank: number; selected: boolean; shortlisted: boolean; onSelect: () => void; onShortlist: () => void;
}) {
  return (
    <article className={`rounded-2xl border bg-white p-5 shadow-sm transition ${selected ? 'border-[#FF3621]/50 ring-2 ring-[#FF3621]/10' : 'border-black/10 hover:border-black/20'}`}>
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-start gap-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#0B2026] text-sm font-semibold text-white">{rank}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <ConfidenceBadge value={candidate.evidence_confidence} />
              <span className="rounded-full bg-black/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide">Score {Number(candidate.referral_score).toFixed(0)}</span>
            </div>
            <h3 className="mt-3 text-lg font-semibold">{candidate.name || 'Unnamed facility'}</h3>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-black/50"><MapPin className="h-3.5 w-3.5" />{[candidate.city, candidate.district_name, candidate.state_name, candidate.postal_code].filter(Boolean).join(', ')}</p>
            <p className="mt-3 text-sm leading-6 text-black/65">{excerpt(candidate.evidence_capabilities || candidate.evidence_specialties || candidate.evidence_description, 180) || 'No concise capability evidence is available.'}</p>
          </div>
        </div>
      </button>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-black/8 pt-4">
        <div className="flex flex-wrap gap-3 text-xs text-black/50"><span>Care match {Number(candidate.capability_match_score).toFixed(0)}%</span><span>Evidence {Number(candidate.evidence_score).toFixed(0)}/100</span></div>
        <Button size="sm" variant={shortlisted ? 'default' : 'outline'} onClick={onShortlist}>
          {shortlisted ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Star className="mr-1.5 h-3.5 w-3.5" />}{shortlisted ? 'Shortlisted' : 'Shortlist'}
        </Button>
      </div>
    </article>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const style = value === 'High' ? 'bg-emerald-100 text-emerald-800' : value === 'Medium' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800';
  return <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${style}`}>{value} evidence</span>;
}

function EvidencePanel({ candidate, note, onNoteChange, onSelect }: { candidate: ReferralCandidate | null; note: string; onNoteChange: (value: string) => void; onSelect: () => void }) {
  if (!candidate) return <div className="rounded-2xl bg-[#0B2026] p-8 text-center text-white/60">Select a facility to review evidence.</div>;
  const sourceUrl = firstUrl(candidate.evidence_source_urls);
  const evidence = [
    ['Capability claims', candidate.evidence_capabilities] as [string, unknown],
    ['Specialties', candidate.evidence_specialties] as [string, unknown],
    ['Procedures', candidate.evidence_procedures] as [string, unknown],
    ['Equipment', candidate.evidence_equipment] as [string, unknown],
    ['Facility description', candidate.evidence_description] as [string, unknown],
  ].filter((item) => toDisplayText(item[1]));

  return (
    <aside className="self-start rounded-2xl bg-[#0B2026] p-5 text-white xl:sticky xl:top-5">
      <p className="eyebrow !text-[#FF8A78]">What the data supports</p>
      <h3 className="mt-2 text-xl font-semibold">{candidate.name}</h3>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <InfoTile label="Referral score" value={Number(candidate.referral_score).toFixed(0)} />
        <InfoTile label="Evidence score" value={`${Number(candidate.evidence_score).toFixed(0)}/100`} />
        <InfoTile label="Record quality" value={candidate.record_quality} />
        <InfoTile label="District need" value={candidate.district_need_score == null ? 'Unavailable' : Number(candidate.district_need_score).toFixed(1)} />
      </div>
      <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-200/10 p-3 text-xs leading-5 text-amber-50/70">
        This record cannot confirm current availability, acceptance, clinical appropriateness, cost, or transfer eligibility.
      </div>
      <div className="mt-4 space-y-3">
        {evidence.map(([label, value]) => (
          <details key={label} className="group rounded-xl border border-white/12 bg-white/[0.04] p-3">
            <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold text-white/75">{label}<ChevronDown className="h-4 w-4 transition group-open:rotate-180" /></summary>
            <p className="mt-3 max-h-40 overflow-y-auto text-xs leading-5 text-white/60">{excerpt(value, 900)}</p>
          </details>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {toDisplayText(candidate.official_phone) && <a className="evidence-link" href={`tel:${toDisplayText(candidate.official_phone)}`}><Phone className="h-3.5 w-3.5" /> Call</a>}
        {toDisplayText(candidate.official_website) && <a className="evidence-link" href={websiteHref(candidate.official_website)} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Website</a>}
        {sourceUrl && <a className="evidence-link" href={sourceUrl} target="_blank" rel="noreferrer"><FileText className="h-3.5 w-3.5" /> Source</a>}
      </div>
      <label className="mt-5 block">
        <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-white/70"><MessageSquareText className="h-3.5 w-3.5" /> Coordinator note or override reason</span>
        <textarea className="min-h-20 w-full rounded-lg border border-white/15 bg-white/8 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30" value={note} placeholder="What must be verified before handoff?" onChange={(event) => onNoteChange(event.target.value)} />
      </label>
      <Button className="mt-3 w-full bg-[#FF3621] text-white hover:bg-[#E62F1C]" onClick={onSelect}><ClipboardCheck className="mr-2 h-4 w-4" /> Select for referral</Button>
    </aside>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-white/[0.06] p-3"><p className="text-[10px] uppercase tracking-wide text-white/35">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>;
}
