const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

export async function generateCommitMessage(
  apiKey: string,
  filePath: string,
  fileContent: string
): Promise<string> {
  const snippet = fileContent.slice(0, 3000);
  const prompt = [
    'Write a single-line Git commit message using Conventional Commits format',
    '(e.g., feat: add login validation, fix: handle empty cart, style: update navbar).',
    'Rules: max 65 characters, lowercase after prefix, no quotes, no markdown, no extra text.',
    `File: ${filePath}`,
    'Code:',
    snippet
  ].join('\n');

  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!res.ok) {
    throw new Error(`Gemini API returned ${res.status}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) {
    return `update: ${filePath}`;
  }

  return raw.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').slice(0, 72);
}
