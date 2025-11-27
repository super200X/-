import { GoogleGenAI, Type, Schema } from "@google/genai";
import { GeneratedScene } from "../types";

// Helper to get client with dynamic key
const getAiClient = (apiKey: string) => {
    // Safely access env var or use passed key
    const envKey = typeof process !== 'undefined' && process.env ? process.env.API_KEY : '';
    return new GoogleGenAI({ apiKey: apiKey || envKey });
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ANALYSIS_SYSTEM_INSTRUCTION = `
You are an expert Visual Novel Director. Your goal is to create illustrations that perfectly match the specific narrative moments in a modern emotional story.

**Constraint Checklist:**
1.  **Quantity:** EXACTLY 6 scenes.
2.  **Style:** MODERN REALISTIC (unless text specifies otherwise).
3.  **Characters:** Asian.
4.  **Framing:** Medium Shot or Wide Shot (NO close-ups).

**Deep Relevance Strategy (CRITICAL):**
*   **Visual Extension:** The image must not just match the text, it must **extend** the reader's experience of the moment. It should capture the atmosphere and specific details described in the text **immediately surrounding** the quote.
*   **Contextual Binding:** If the text mentions a specific prop (e.g., "a torn divorce paper"), action (e.g., "slumping against the door"), or lighting (e.g., "neon lights reflecting on rain"), it **MUST** appear in the visual description.
*   **Scene 1 Placement:** This scene represents the transition from the Introduction to the Main Body (Section 01). It should depict the lingering emotion of the intro or the opening state of the protagonist.

**Safety & Terminology:**
*   **Avoid Triggers:** Do NOT use words like "fight", "hit", "blood", "kill", "abuse".
*   **Use Safe Synonyms:** Instead use "arguing", "confronting", "mourning", "disheveled", "tense moment", "sorrowful".

**Selection Criteria:**
*   **Scene 1:** Must be located at the very end of the introduction (immediately before Section 1/01).
*   **Scenes 2-6:** Distribute evenly across the remainder of the story.

**Visual Prompt Construction:**
*   **Format:** "Asian [Subject] [Specific Action], [Interacting with Specific Object], [Detailed Location/Background], [Lighting/Mood], Medium Shot"
*   **Example:** "Asian woman sitting on floor crying, holding a crumpled letter, scattered papers around, dimly lit bedroom, sorrowful atmosphere, Medium Shot"

Return a JSON object with the scenes array.
`;

const sceneSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER },
          quote: { 
            type: Type.STRING,
            description: "A unique sentence snippet from the text where the image should be placed." 
          },
          contextDescription: {
            type: Type.STRING,
            description: "A summary of the specific plot action happening here (e.g., 'Protagonist is packing bags to leave')."
          },
          visualPrompt: { 
            type: Type.STRING,
            description: "A highly specific, literal visual description of the scene. Must include Asian characters, specific actions, objects, and setting mentioned in the text."
          },
          reasoning: {
            type: Type.STRING,
            description: "Why this moment needs an image."
          }
        },
        required: ["id", "quote", "contextDescription", "visualPrompt", "reasoning"],
      },
    },
  },
};

export const analyzeStoryText = async (fullText: string, apiKey: string): Promise<GeneratedScene[]> => {
  const ai = getAiClient(apiKey);
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", 
      contents: `Analyze this text and generate exactly 6 visual scenes for a modern emotional article. Text:\n\n${fullText}`,
      config: {
        systemInstruction: ANALYSIS_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: sceneSchema,
        thinkingConfig: { thinkingBudget: 2048 }, 
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ]
      },
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    const result = JSON.parse(text);
    
    // Ensure we have scenes
    let finalScenes = result.scenes || [];
    
    if (finalScenes.length === 0) throw new Error("AI failed to identify scenes.");

    return finalScenes.map((s: any) => ({
      ...s,
      status: 'pending'
    }));

  } catch (error) {
    console.error("Analysis failed:", error);
    throw error;
  }
};

// Helper to remove violent/sensitive words but KEEP setting/context
const smartSanitizePrompt = (prompt: string): string => {
    const triggers = [
        'blood', 'bleeding', 'wound', 'injury', 'injured', 'scar',
        'gun', 'pistol', 'knife', 'weapon', 'sword', 'kill', 'murder', 'dead', 'corpse',
        'fight', 'fighting', 'punch', 'kick', 'hit', 'strangle', 'choke', 'beat', 'attack',
        'naked', 'nude', 'undressed', 'sex', 'sexual', 'kiss', 'making out', 'lingerie', 'underwear',
        'suicide', 'hanging', 'abuse', 'drug', 'cigarette', 'smoking', 'alcohol',
        'bed', 'bedroom', 'sleeping', 'intimate' // High risk for false positive safety blocks
    ];
    
    let safe = prompt;
    triggers.forEach(t => {
        const reg = new RegExp(`\\b${t}\\w*\\b`, 'gi');
        safe = safe.replace(reg, '');
    });

    // Add generic emotional context if too short
    if (safe.length < 20) {
        safe += ", emotional atmosphere, dramatic lighting, modern style";
    }
    
    return safe;
};

// Client-side image compression
const compressImage = async (base64Str: string, maxSizeBytes: number, maxWidth: number): Promise<string> => {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            // Resize dimensions first
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }

            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve(base64Str); // Fail safe
                return;
            }
            
            // Draw image to canvas
            ctx.drawImage(img, 0, 0, width, height);

            // Iterative compression
            // For higher quality targets (larger files), start higher
            let quality = maxSizeBytes > 100 * 1024 ? 0.95 : 0.8;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            
            // Approximate size check (Base64 is ~1.33x binary size, so we multiply length by 0.75)
            // Loop until size is acceptable or quality is too low (0.1)
            while (dataUrl.length * 0.75 > maxSizeBytes && quality > 0.1) {
                quality -= 0.1;
                dataUrl = canvas.toDataURL('image/jpeg', quality);
            }

            resolve(dataUrl);
        };
        img.onerror = () => {
            // If image loading fails, just return original
            resolve(base64Str);
        };
        img.src = base64Str;
    });
};

export const generateImageForScene = async (prompt: string, apiKey: string, sceneId: number, isRetry: boolean = false, attempt: number = 1): Promise<string> => {
  const ai = getAiClient(apiKey);
  
  // Determine compression targets based on Scene ID
  // Scene 1 (Cover/Intro): High Quality (Max 300KB, 1280px width)
  // Scenes 2-6: Lightweight (Max 50KB, 800px width)
  const isCover = sceneId === 1;
  const maxSizeBytes = isCover ? 300 * 1024 : 50 * 1024;
  const maxWidth = isCover ? 1280 : 800;

  // 1. Initial Cleanup
  let cleanPrompt = prompt
      .replace(/Ratio:\s*16:9;?/gi, '')
      .replace(/Chapter:.*?;?/gi, '')
      .replace(/close-?up/gi, 'medium shot')
      .replace(/macro/gi, '')
      .replace(/extreme detail/gi, '')
      .replace(/face focus/gi, '')
      .trim();
  
  cleanPrompt = cleanPrompt.replace(/^(Generate )?(a )?(photorealistic )?cinematic movie still,?\s*/i, '');
  
  // Enforce Asian Ethnicity
  if (!cleanPrompt.toLowerCase().includes('asian')) {
    cleanPrompt = `Asian subjects, ${cleanPrompt}`;
  }

  // If retrying (Safety Attempt 1), apply SMART sanitization
  if (isRetry && !cleanPrompt.includes("Abstract cinematic composition")) {
      console.log("Applying smart sanitization to prompt...");
      cleanPrompt = smartSanitizePrompt(cleanPrompt);
  }

  // Final Construction
  const finalPrompt = `Cinematic photo of ${cleanPrompt}, Modern realistic style, detailed background, natural lighting.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: finalPrompt }] },
      config: {
        imageConfig: {
          aspectRatio: "16:9",
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ]
      }
    });

    const candidate = response.candidates?.[0];
    
    if (!candidate) {
        throw new Error("No candidates returned (Potential Block)");
    }

    // Check for Safety Blocks
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        const reason = candidate.finishReason;
        const msg = `Image generation stopped. Reason: ${reason}`;
        
        // RECURSIVE RETRY ON SAFETY FAILURE
        // Checks for 'SAFETY', 'IMAGE_SAFETY', 'BLOCK', etc.
        const isSafety = reason.includes('SAFETY') || reason === 'RECITATION' || reason === 'OTHER' || reason.includes('BLOCK');
        
        if (isSafety) {
             if (!isRetry) {
                 // Attempt 2: Try Sanitized Prompt
                 console.warn(`Safety filter (${reason}) triggered. Retrying with sanitized prompt...`);
                 return await generateImageForScene(prompt, apiKey, sceneId, true);
             } else {
                 // Attempt 3: Ultra Safe Fallback
                 const ultraSafePrompt = "Abstract cinematic composition, soft lighting, asian style, emotional atmosphere, blurry background";
                 
                 // Avoid infinite loop if we are already using the ultra safe prompt
                 if (!prompt.includes("Abstract cinematic composition")) {
                    console.warn(`Sanitized prompt also failed (${reason}). Retrying with ULTRA SAFE fallback...`);
                    return await generateImageForScene(ultraSafePrompt, apiKey, sceneId, true);
                 }
             }
        }
        
        throw new Error(msg);
    }

    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
         const rawBase64 = `data:image/png;base64,${part.inlineData.data}`;
         // Compress image before returning, passing specific limits
         return await compressImage(rawBase64, maxSizeBytes, maxWidth);
      }
    }
    
    // Fallback: If no image data but we haven't retried yet
    if (!isRetry) {
         console.warn("No image data found. Retrying with sanitized prompt...");
         return await generateImageForScene(prompt, apiKey, sceneId, true);
    }
    
    throw new Error("No image data found in response");

  } catch (error: any) {
    // RATE LIMIT HANDLING (429 / Resource Exhausted)
    // We explicitly re-throw specific status codes so App.tsx can intercept them for Key Switching
    if (error.status === 'RESOURCE_EXHAUSTED' || error.code === 429 || (error.message && error.message.includes('429'))) {
        if (attempt <= 3) {
            // Limited internal retry (reduced to 3 to fail faster and let user switch key)
            const delayTime = 5000 * Math.pow(1.5, attempt - 1); 
            console.warn(`Rate limit hit (429). Waiting ${delayTime/1000}s before retry attempt ${attempt}...`);
            await wait(delayTime);
            return await generateImageForScene(prompt, apiKey, sceneId, isRetry, attempt + 1);
        } else {
             // Throw specific error for App to catch
             const quotaError = new Error("QUOTA_EXCEEDED");
             (quotaError as any).code = 429;
             throw quotaError;
        }
    }

    // Catch-all for permission or 400 errors that might be content related
    if (!isRetry && (error.message?.includes('SAFETY') || error.message?.includes('PERMISSION_DENIED') || error.message?.includes('400') || error.message?.includes('403'))) {
         console.warn("Safety/Permission/API error caught. Retrying with sanitized prompt...");
         return await generateImageForScene(prompt, apiKey, sceneId, true);
    }

    console.error("Image generation failed:", error);
    throw error;
  }
};