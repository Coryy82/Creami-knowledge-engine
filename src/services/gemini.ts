import { GoogleGenAI, Type } from "@google/genai";
import { Recipe } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function extractRecipeFromTranscript(transcript: string, youtubeId: string): Promise<Partial<Recipe>> {
  const model = "gemini-3-flash-preview";
  
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
  `;

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
          notes: { type: Type.STRING }
        },
        required: ["title", "ingredients", "steps", "category"]
      }
    }
  });

  const content = response.text;
  if (!content) throw new Error("AI failed to extract recipe");
  
  const extracted = JSON.parse(content);
  return {
    ...extracted,
    youtubeId,
    youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    createdAt: new Date().toISOString()
  };
}

export async function queryRecipes(userQuery: string, recipes: Recipe[]): Promise<string> {
  const model = "gemini-3-flash-preview";
  
  const context = recipes.map(r => `
    TITLE: ${r.title}
    CATEGORY: ${r.category}
    INGREDIENTS: ${r.ingredients.join(", ")}
    STEPS: ${r.steps.join(". ")}
    NOTES: ${r.notes || "None"}
    URL: ${r.youtubeUrl}
  `).join("\n---");

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

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      systemInstruction: "You are a helpful and entusiastic ice cream expert. Always refer to specific recipes from the database provided."
    }
  });

  return response.text || "I couldn't find an answer for that.";
}
