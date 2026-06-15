import { expect, test } from '@playwright/test';

function analyticsSse(data: unknown) {
  return `data: ${JSON.stringify({ type: 'result', data })}\n\n`;
}

const facilityRows = [
  {
    facility_id: 'facility-1',
    canonical_name: 'Lilavati Hospital and Research Centre',
    facility_type: 'Hospital',
    operator_type: 'Private',
    city: 'Mumbai',
    state_region: 'Maharashtra',
    postal_code: '400050',
    address_full: 'Bandra Reclamation Rd, Mumbai, Maharashtra, India',
    contacts: '+917718823001, lilavatihospital.com',
    specialties: 'Cardiology, Orthopedic Surgery',
    procedures: 'Angioplasty, Transcatheter Aortic Valve Replacement',
    gold_confidence_score: 1,
    specialty_confidence: 0.98,
    procedure_confidence: 0.94,
    specialty_evidence_count: 4,
    has_center_of_excellence: 1,
    has_inpatient_support: 1,
    has_outpatient_support: 1,
    requires_special_equipment: 1,
    match_score: 24.9,
  },
];

test('grounded facility chat queries analytics before model serving', async ({ page }) => {
  let analyticsCalled = false;
  let servingPayload = '';

  await page.route('**/api/analytics/query/facility_grounding', async (route) => {
    analyticsCalled = true;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: analyticsSse(facilityRows),
    });
  });
  await page.route('**/api/serving/invoke', async (route) => {
    servingPayload = route.request().postData() ?? '';
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: 'Lilavati Hospital and Research Centre in Mumbai matches the cardiology request.',
            },
          },
        ],
      },
    });
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Facility Chatbot' })).toBeVisible();
  await expect(page.getByLabel('Grounding data status')).toContainText('Facility Tables');

  await page.getByRole('textbox', { name: 'Message' }).fill('Find cardiology hospitals in Mumbai with contact details.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Lilavati Hospital and Research Centre in Mumbai matches the cardiology request.')).toBeVisible();
  await expect(page.getByText('Grounded', { exact: true })).toBeVisible();
  expect(analyticsCalled).toBe(true);
  expect(servingPayload).toContain('Facility context');
  expect(servingPayload).toContain('Lilavati Hospital and Research Centre');
});

test('short ambiguous text still searches facility tables', async ({ page }) => {
  let analyticsCalled = false;
  let servingPayload = '';

  await page.route('**/api/analytics/query/facility_grounding', async (route) => {
    analyticsCalled = true;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: analyticsSse(facilityRows),
    });
  });
  await page.route('**/api/serving/invoke', async (route) => {
    servingPayload = route.request().postData() ?? '';
    await route.fulfill({
      json: {
        choices: [{ message: { content: 'Mumbai facility evidence was searched.' } }],
      },
    });
  });

  await page.goto('/');

  await page.getByRole('textbox', { name: 'Message' }).fill('Mumbai');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Mumbai facility evidence was searched.')).toBeVisible();
  expect(analyticsCalled).toBe(true);
  expect(servingPayload).toContain('Facility context');
});

test('general-looking text still uses facility analytics', async ({ page }) => {
  let analyticsCalled = false;
  let servingPayload = '';

  await page.route('**/api/analytics/query/facility_grounding', async (route) => {
    analyticsCalled = true;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: analyticsSse(facilityRows),
    });
  });
  await page.route('**/api/serving/invoke', async (route) => {
    servingPayload = route.request().postData() ?? '';
    await route.fulfill({
      json: {
        choices: [{ message: { content: 'Vector search compares meaning, not exact keywords.' } }],
      },
    });
  });

  await page.goto('/');

  await page.getByRole('textbox', { name: 'Message' }).fill('Explain vector search in plain English.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Vector search compares meaning, not exact keywords.')).toBeVisible();
  expect(analyticsCalled).toBe(true);
  expect(servingPayload).toContain('Facility context');
});

test('example prompts populate the composer', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Find cardiology hospitals in Mumbai with contact details.' }).click();

  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Find cardiology hospitals in Mumbai with contact details.'
  );
});
