const MIDDLE_DOT = '\u00b7';

const SUMMARY = `$0.7 / 1M Input ${MIDDLE_DOT} $0.13 / 1M Cached input ${MIDDLE_DOT} $2.2 / 1M Output`;

export const devinModelsListFixture = JSON.stringify({
  families: [
    {
      family_label: 'Claude',
      family_uid: 'claude-family',
      slug: 'claude',
      aliases: [],
      variants: [
        {
          model_uid: 'claude-sonnet-4-20250514',
          label: 'Claude Sonnet 4',
          max_context_tokens: 200000,
          max_output_tokens: 8192,
          cost_tier: 'Paid',
          cost_summary: SUMMARY,
          is_new: false,
          is_beta: false,
        },
      ],
    },
  ],
});

export const devinModelsCaptureOptions = {
  devinCliVersion: 'v1',
  runModelsList: async (): Promise<string> => devinModelsListFixture,
};
