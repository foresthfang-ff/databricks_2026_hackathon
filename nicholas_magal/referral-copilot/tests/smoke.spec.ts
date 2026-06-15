import { expect, test } from '@playwright/test';

function sse(data: unknown) {
  return `data: ${JSON.stringify({ type: 'result', data })}\n\n`;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/analytics/query/referral_summary', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse([
        {
          facility_count: 9989,
          high_confidence_count: 9934,
          contactable_count: 9200,
          district_context_count: 1000,
          average_evidence_score: 92.3,
        },
      ]),
    });
  });
  await page.route('**/api/referrals/cases', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({
      status: 201,
      json: {
        case_id: 'ui-test-case',
        title: 'NICU referral',
        patient_context: 'Needs wheelchair access and transfer coordination',
        care_need: 'neonatal intensive care with ventilator support',
        location: 'Bengaluru',
        urgency: 'soon',
        status: 'open',
        updated_at: '2026-06-15T19:45:00Z',
      },
    });
  });
  await page.route('**/api/analytics/query/referral_search', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse([
        {
          facility_id: 'facility-array-evidence',
          name: 'SPARSH Hospital, Hennur Road',
          facility_type: 'hospital',
          operator_type: 'private',
          city: 'Bengaluru',
          district_name: 'Bengaluru Urban',
          state_name: 'Karnataka',
          postal_code: '560001',
          latitude: 12.9716,
          longitude: 77.5946,
          official_phone: ['+91-80-1234-5678'],
          official_website: ['https://www.sparshhospital.com'],
          evidence_score: 100,
          evidence_confidence: 'High',
          record_quality: 'Usable',
          capability_match_score: 95,
          location_match_score: 90,
          referral_score: 94,
          district_need_score: null,
          district_context_available: false,
          evidence_description: { summary: 'Hospital record with neonatal and critical care services.' },
          evidence_specialties: ['Neonatology', 'Pediatrics'],
          evidence_procedures: null,
          evidence_equipment: ['Ventilator support'],
          evidence_capabilities: ['Neonatal intensive care', 'Ventilator support'],
          evidence_source_urls: ['https://www.sparshhospital.com'],
          page_update_date: null,
        },
      ]),
    });
  });
});

test('referral copilot guides the intake conversation', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: "Let's find the right next call." })).toBeVisible();
  await expect(page.getByText('What care, specialty, procedure, or equipment is needed?')).toBeVisible();

  await page.getByLabel('Required care or capability').fill('neonatal intensive care with ventilator support');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByLabel('Referral location')).toBeVisible();

  await page.getByLabel('Referral location').fill('Bengaluru');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await page.getByRole('button', { name: 'Coordinate soon' }).click();

  await page.getByLabel('Referral constraints').fill('Needs wheelchair access and transfer coordination');
  await page.getByRole('button', { name: 'Send answer' }).click();

  await expect(page.getByText('Search criteria')).toBeVisible();
  await expect(
    page.getByRole('definition').filter({ hasText: 'neonatal intensive care with ventilator support' })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Search cited facility evidence' }).click();
  await expect(page.getByRole('button', { name: /SPARSH Hospital, Hennur Road/ })).toBeVisible();
  await expect(page.getByText('Neonatal intensive care, Ventilator support').first()).toBeVisible();
});

test('referral copilot is explicit when evidence cannot support a match', async ({ page }) => {
  await page.route('**/api/analytics/query/referral_search', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: sse([]) });
  });
  await page.goto('/');

  await page.getByLabel('Required care or capability').fill('experimental quantum surgery');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await page.getByLabel('Referral location').fill('Bengaluru');
  await page.getByRole('button', { name: 'Send answer' }).click();
  await page.getByRole('button', { name: 'Coordinate soon' }).click();
  await page.getByRole('button', { name: 'No additional constraints' }).click();
  await page.getByRole('button', { name: 'Search cited facility evidence' }).click();

  await expect(page.getByText('I cannot make a defensible match from the available evidence.')).toBeVisible();
  await expect(page.getByText('This does not mean the service is unavailable.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search all locations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change the care need' })).toBeVisible();
});
