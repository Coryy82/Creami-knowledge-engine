import { GoogleGenAI, Type } from "@google/genai";
import { Recipe } from "../types";

type Provider = "gemini" | "cursor";

function env(name: string, fallback = ""): string {
  const value = (process.env as Record<string, string | undefined>)[name];
  return value ?? fallback;
}

function provider(): Provider {
  const raw = env("LLM_PROVIDER", "cursor").toLowerCase();
  return raw === "cursor" ? "cursor" : "gemini";
}

function hasGeminiKey(): boolean {
  return Boolean(env("GEMINI_API_KEY").trim());
}

function hasCursorKey(): boolean {
  return Boolean(env("CURSOR_API_KEY").trim());
}

function resolveProvider(): Provider {
  const selected = provider();

  if (selected === "gemini" && !hasGeminiKey() && hasCursorKey()) {
    return "cursor";
  }

  if (selected === "cursor" && !hasCursorKey() && hasGeminiKey()) {
    return "gemini";
  }

  return selected;
}

export function getLlmProviderLabel(): string {
  return resolveProvider() === "cursor" ? "Cursor" : "Gemini";
}

function stripJsonFences(input: string): string {
  return input
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

async function callGeminiJson(prompt: string): Promise<string> {
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("Falta GEMINI_API_KEY. Define GEMINI_API_KEY o usa LLM_PROVIDER=cursor con CURSOR_API_KEY.");
  }
  const ai = new GoogleGenAI({ apiKey });
  const model = env("GEMINI_MODEL", "gemini-2.5-flash");

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          ingredients: { type: Type.ARRAY, items: { type: Type.STRING } },
          steps: { type: Type.ARRAY, items: { type: Type.STRING } },
          category: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ["title", "ingredients", "steps", "category"],
      },
    },
  });

  if (!response.text) throw new Error("Gemini no devolvio contenido");
  return response.text;
}

async function callGeminiText(prompt: string): Promise<string> {
  const apiKey = env("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("Falta GEMINI_API_KEY. Define GEMINI_API_KEY o usa LLM_PROVIDER=cursor con CURSOR_API_KEY.");
  }
  const ai = new GoogleGenAI({ apiKey });
  const model = env("GEMINI_MODEL", "gemini-2.5-flash");

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      systemInstruction:
        "You are a helpful and entusiastic ice cream expert. Always refer to specific recipes from the database provided.",
    },
  });

  return response.text || "I couldn't find an answer for that.";
}

async function callCursor(prompt: string, jsonMode: boolean): Promise<string> {
  const response = await fetch("/api/llm", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      jsonMode,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM proxy error ${response.status}: ${errorText.slice(0, 240)}`);
  }

  const data = (await response.json()) as { text?: string };
  const text = data.text;
  if (!text) throw new Error("Cursor API no devolvio contenido");
  return text;
}

async function generateJson(prompt: string): Promise<string> {
  if (resolveProvider() === "cursor") return stripJsonFences(await callCursor(prompt, true));
  return stripJsonFences(await callGeminiJson(prompt));
}

async function generateText(prompt: string): Promise<string> {
  if (resolveProvider() === "cursor") return callCursor(prompt, false);
  return callGeminiText(prompt);
}

export async function extractRecipeFromTranscript(transcript: string, youtubeId: string): Promise<Partial<Recipe>> {
  const prompt = `
    Analyze the following video content.
    It could be a recipe transcript, a title/description pair, or promotional metadata.
    Extract a structured summary.

    CONTENT:
    ${transcript}

    JSON format requirements:
    - title: Descriptive name (use the video title if provided)
    - ingredients: Array of items mentioned (if any). If it's a product review, list key components or specs.
    - steps: Array of instructions or key takeaways.
    - category: Most relevant label (e.g., "Protein Shake", "Ice Cream", "Comparison", "Pro Tip")
    - notes: Any additional context, codes, or tips.

    IMPORTANT: If no recipe is found, sum up the main point of the video in the steps and title.
    Return ONLY valid JSON.
  `;

  const content = await generateJson(prompt);
  const extracted = JSON.parse(content);

  return {
    ...extracted,
    youtubeId,
    youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    createdAt: new Date().toISOString(),
  };
}

export async function queryRecipes(userQuery: string, recipes: Recipe[]): Promise<string> {
  const context = recipes
    .map(
      (r) => `
    TITLE: ${r.title}
    CATEGORY: ${r.category}
    INGREDIENTS: ${r.ingredients.join(", ")}
    STEPS: ${r.steps.join(". ")}
    NOTES: ${r.notes || "None"}
    URL: ${r.youtubeUrl}
  `,
    )
    .join("\n---");

  const prompt = `
    You are an expert Ninja Creami assistant.
    Use the following database of recipes to answer the user's question.
    If multiple recipes match, mention them. If no recipe matches, say so.
    Be specific about ingredients and tips.

    DATABASE:
    ${context}

    USER QUESTION:
    ${userQuery}
  `;

  return generateText(prompt);
}
