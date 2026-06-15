import type { Application, Request } from 'express';
import { z } from 'zod';

interface QueryResult {
  rows: Record<string, unknown>[];
}

interface ReferralAppKit {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<QueryResult>;
  };
  serving(alias: string): {
    asUser(req: Request): {
      invoke(body: unknown): Promise<unknown>;
    };
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const CaseInput = z.object({
  title: z.string().trim().min(1).max(160),
  patientContext: z.string().trim().max(2000).default(''),
  careNeed: z.string().trim().min(1).max(500),
  location: z.string().trim().max(160).default(''),
  urgency: z.enum(['routine', 'soon', 'urgent']).default('routine'),
});

const DecisionInput = z.object({
  facilityId: z.string().trim().min(1).max(255),
  facilityName: z.string().trim().min(1).max(500),
  action: z.enum(['shortlist', 'remove', 'selected', 'declined']),
  note: z.string().trim().max(2000).default(''),
  score: z.number().finite().optional(),
});

const ChatInput = z.object({
  step: z.enum(['careNeed', 'location', 'urgency', 'context', 'review', 'results']),
  previousStep: z.enum(['careNeed', 'location', 'urgency', 'context', 'review', 'results']).optional(),
  userAnswer: z.string().trim().max(2000).default(''),
  draft: z.object({
    title: z.string().trim().max(160).default(''),
    patientContext: z.string().trim().max(2000).default(''),
    careNeed: z.string().trim().max(500).default(''),
    location: z.string().trim().max(160).default(''),
    urgency: z.enum(['routine', 'soon', 'urgent']).default('soon'),
  }),
  messages: z.array(
    z.object({
      role: z.enum(['assistant', 'user']),
      text: z.string().trim().max(2000),
    })
  ).max(12).default([]),
});

const ExplainInput = z.object({
  case: CaseInput,
  candidates: z.array(
    z.object({
      facility_id: z.string(),
      name: z.string().nullable(),
      referral_score: z.number(),
      evidence_confidence: z.string(),
      record_quality: z.string(),
      city: z.string().nullable(),
      state_name: z.string().nullable(),
      official_phone: z.string().nullable(),
      official_website: z.string().nullable(),
      evidence_description: z.string().nullable(),
      evidence_specialties: z.string().nullable(),
      evidence_procedures: z.string().nullable(),
      evidence_equipment: z.string().nullable(),
      evidence_capabilities: z.string().nullable(),
      evidence_source_urls: z.string().nullable(),
    })
  ).min(1).max(5),
});

function requester(req: Request) {
  return req.header('x-forwarded-email') || 'workspace-user';
}

function extractText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const body = response as Record<string, unknown>;
  if (body.data && typeof body.data === 'object') {
    return extractText(body.data);
  }
  for (const key of ['output_text', 'generated_text', 'text']) {
    if (typeof body[key] === 'string') return body[key];
  }
  const choices = body.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) {
      return message.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const typedPart = part as Record<string, unknown>;
            return typeof typedPart.text === 'string' ? typedPart.text : '';
          }
          return '';
        })
        .join('');
    }
    if (typeof first?.text === 'string') return first.text;
  }
  for (const key of ['predictions', 'outputs']) {
    if (Array.isArray(body[key]) && body[key].length > 0) return extractText(body[key][0]);
  }
  if (typeof body.content === 'string') return body.content;
  return JSON.stringify(response);
}

type ExplainPayload = z.infer<typeof ExplainInput>;
type ChatPayload = z.infer<typeof ChatInput>;

function fallbackChatReply(payload: ChatPayload): string {
  const careNeed = payload.draft.careNeed || payload.userAnswer;
  const location = payload.draft.location;
  const urgency = payload.draft.urgency;

  if (payload.step === 'location') {
    return `Got it: ${careNeed || 'that care need'}. Where should I search? Enter a city, district, state, or 6-digit pincode, or search across India.`;
  }
  if (payload.step === 'urgency') {
    return `I’ll look for ${careNeed || 'that referral need'}${location ? ` near ${location}` : ' across India'}. How quickly does this need to be coordinated?`;
  }
  if (payload.step === 'context') {
    return `${urgency === 'urgent' ? 'Urgent coordination noted.' : 'Timing noted.'} Are there any non-identifying constraints I should consider, such as mobility, language, transfer timing, or equipment?`;
  }
  if (payload.step === 'review') {
    return `I have enough information to search for ${careNeed || 'this referral'}${location ? ` near ${location}` : ' across India'}. Review the request below, then start the evidence search.`;
  }
  if (payload.step === 'results') {
    return `I’m checking the available facility evidence for "${payload.draft.careNeed}"${payload.draft.location ? ` near ${payload.draft.location}` : ' across India'}. I will only recommend records with enough matching evidence.`;
  }
  return 'What care, specialty, procedure, or equipment is needed?';
}

function cleanChatReply(reply: string): string {
  return reply
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortEvidence(candidate: ExplainPayload['candidates'][number]): string {
  const value =
    candidate.evidence_capabilities ||
    candidate.evidence_specialties ||
    candidate.evidence_procedures ||
    candidate.evidence_equipment ||
    candidate.evidence_description;
  if (!value) return 'No concise capability claim is available in the source record.';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function deterministicBrief(payload: ExplainPayload): string {
  const [first, ...alternatives] = payload.candidates;
  const firstLocation = [first.city, first.state_name].filter(Boolean).join(', ') || 'location not listed';
  const alternativeLines = alternatives.slice(0, 2).map((candidate) => {
    const location = [candidate.city, candidate.state_name].filter(Boolean).join(', ') || 'location not listed';
    return `- **${candidate.name || 'Unnamed facility'}** (${location}, score ${candidate.referral_score.toFixed(0)}, ${candidate.evidence_confidence.toLowerCase()} evidence): "${shortEvidence(candidate)}"`;
  });

  return `### Recommended first call
**${first.name || 'Unnamed facility'}** (${firstLocation}) is the highest-ranked supplied option at ${first.referral_score.toFixed(0)}. Source evidence: "${shortEvidence(first)}"

### Alternatives and tradeoffs
${alternativeLines.length > 0 ? alternativeLines.join('\n') : '- No additional ranked candidates were supplied.'}

### Evidence limitations
- These are source claims, not verified current capability, clinical appropriateness, bed availability, or acceptance.
- Confidence for the first option is **${first.evidence_confidence}** and record quality is **${first.record_quality}**.
- Verify the required service, current availability, transfer criteria, cost or coverage, and contact details directly by phone.

### Suggested handoff checklist
- Confirm the requested capability: ${payload.case.careNeed}.
- Confirm urgency, acceptance criteria, and an appropriate receiving clinician.
- Record who confirmed availability, the confirmation time, and any override reason.
- Share only the minimum necessary patient information through an approved clinical channel.

_This brief used the deterministic evidence fallback because model synthesis was unavailable._`;
}

export async function setupReferralRoutes(appkit: ReferralAppKit) {
  await appkit.lakebase.query(`
    CREATE SCHEMA IF NOT EXISTS referral_copilot;

    CREATE TABLE IF NOT EXISTS referral_copilot.cases (
      case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_email TEXT NOT NULL,
      title TEXT NOT NULL,
      patient_context TEXT NOT NULL DEFAULT '',
      care_need TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      urgency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS referral_copilot.decisions (
      decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      case_id UUID NOT NULL REFERENCES referral_copilot.cases(case_id) ON DELETE CASCADE,
      owner_email TEXT NOT NULL,
      facility_id TEXT NOT NULL,
      facility_name TEXT NOT NULL,
      action TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      score DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  appkit.server.extend((app) => {
    app.get('/api/referrals/cases', async (req, res) => {
      const result = await appkit.lakebase.query(
        `SELECT * FROM referral_copilot.cases WHERE owner_email = $1 ORDER BY updated_at DESC LIMIT 50`,
        [requester(req)]
      );
      res.json(result.rows);
    });

    app.post('/api/referrals/cases', async (req, res) => {
      const parsed = CaseInput.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid referral case.', details: parsed.error.flatten() });
        return;
      }
      const input = parsed.data;
      const result = await appkit.lakebase.query(
        `INSERT INTO referral_copilot.cases
          (owner_email, title, patient_context, care_need, location, urgency)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [requester(req), input.title, input.patientContext, input.careNeed, input.location, input.urgency]
      );
      res.status(201).json(result.rows[0]);
    });

    app.get('/api/referrals/cases/:caseId/decisions', async (req, res) => {
      const result = await appkit.lakebase.query(
        `SELECT * FROM referral_copilot.decisions
         WHERE case_id = $1 AND owner_email = $2
         ORDER BY created_at DESC`,
        [req.params.caseId, requester(req)]
      );
      res.json(result.rows);
    });

    app.post('/api/referrals/cases/:caseId/decisions', async (req, res) => {
      const parsed = DecisionInput.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid referral decision.', details: parsed.error.flatten() });
        return;
      }
      const input = parsed.data;
      const result = await appkit.lakebase.query(
        `INSERT INTO referral_copilot.decisions
          (case_id, owner_email, facility_id, facility_name, action, note, score)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.params.caseId,
          requester(req),
          input.facilityId,
          input.facilityName,
          input.action,
          input.note,
          input.score ?? null,
        ]
      );
      await appkit.lakebase.query(
        `UPDATE referral_copilot.cases SET updated_at = now() WHERE case_id = $1 AND owner_email = $2`,
        [req.params.caseId, requester(req)]
      );
      res.status(201).json(result.rows[0]);
    });

    app.post('/api/referrals/chat', async (req, res) => {
      const parsed = ChatInput.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid chat request.', details: parsed.error.flatten() });
        return;
      }

      const payload = parsed.data;
      const fallback = fallbackChatReply(payload);
      const prompt = `You are the conversational intake assistant for a healthcare referral copilot.
The app has a fixed workflow. Your job is to respond naturally and ask for exactly the next required field.

Workflow step to ask for now: ${payload.step}
Previous step: ${payload.previousStep || 'none'}
Most recent user answer: ${payload.userAnswer || 'none'}

Current referral draft:
${JSON.stringify(payload.draft)}

Recent conversation:
${JSON.stringify(payload.messages)}

Rules:
- Return only the next assistant message as plain text, no JSON and no markdown.
- Keep it under 45 words and write one conversational sentence.
- Use the current referral draft and most recent user answer. The response must include one concrete value from the UI state whenever one exists, such as the care need, location, urgency, or constraint.
- Do not ask for names, identifiers, diagnosis, treatment advice, insurance, or protected health information.
- Never ask where the patient is located. Ask for the referral search area, facility search area, city, district, state, or pincode instead.
- Do not recommend facilities in intake. Recommendations happen after the evidence search.
- If step is "location", acknowledge the care need from the draft, then ask for city, district, state, or pincode and mention they can search across India.
- If step is "urgency", acknowledge the care need and location/search scope, then ask how quickly coordination is needed.
- If step is "context", acknowledge the urgency, then ask for non-identifying constraints only.
- If step is "review", summarize care need, location/search scope, and urgency, then tell the user there is enough information to review and start the evidence search.
- If step is "results", say you are checking facility evidence for the care need and location/search scope.`;

      try {
        const response = await appkit.serving('referral').asUser(req).invoke({
          messages: [
            {
              role: 'system',
              content:
                'You are a concise healthcare referral intake assistant. Use Databricks-hosted model serving. Ground every reply in the supplied UI state, ask only for the next workflow field, and avoid patient identifiers or medical advice.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 120,
        });
        const reply = cleanChatReply(extractText(response));
        res.json({ reply: reply || fallback, mode: reply ? 'model' : 'deterministic-fallback' });
      } catch (error) {
        console.error('Referral chat failed:', error);
        res.json({ reply: fallback, mode: 'deterministic-fallback' });
      }
    });

    app.post('/api/referrals/explain', async (req, res) => {
      const parsed = ExplainInput.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid explanation request.' });
        return;
      }

      const prompt = `You are an evidence-grounded healthcare referral coordinator copilot.
Recommend from only the supplied ranked candidates. The supplied candidates are retrieved from these Databricks tables:
- medallion_architecture.gold.gold_facility_contact
- medallion_architecture.gold.gold_facility_location
- medallion_architecture.gold.gold_facility_specialty
- medallion_architecture.silver.silver_facility_equipment_evidence

Never use outside knowledge. Never claim that a facility can provide care beyond the quoted source evidence.
Never mention, infer, or invent a facility that is not in the supplied candidate array. If fewer than three candidates
are supplied, explicitly state that fewer alternatives were available. Clearly label missing or weak evidence.
This is coordination support, not medical advice.

Referral case:
${JSON.stringify(parsed.data.case)}

Ranked candidates with exact source evidence:
${JSON.stringify(parsed.data.candidates)}

Return concise markdown with:
1. Recommended first call and why
2. Up to two supplied alternatives and tradeoffs
3. Evidence limitations and questions the coordinator must verify by phone
4. Suggested handoff checklist
Cite facilities by name and quote only short phrases from their supplied evidence fields.`;

      try {
        const response = await appkit.serving('referral').asUser(req).invoke({
          messages: [
            {
              role: 'system',
              content:
                'Ground every recommendation only in the supplied Databricks facility rows. Never invent facilities, services, equipment, contact details, or facts. Communicate uncertainty and do not provide diagnosis or treatment advice.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 900,
        });
        const explanation = extractText(response);
        if (!explanation) {
          res.json({ explanation: deterministicBrief(parsed.data), mode: 'deterministic-fallback' });
          return;
        }
        res.json({ explanation, mode: 'model' });
      } catch (error) {
        console.error('Referral explanation failed:', error);
        res.json({ explanation: deterministicBrief(parsed.data), mode: 'deterministic-fallback' });
      }
    });
  });
}
