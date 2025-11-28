import { GoogleGenAI, Type, Schema } from "@google/genai";
import { GeneratedScene } from "../types";

// Helper to get client with dynamic key and custom Base URL
const getAiClient = (apiKey: string, baseUrl?: string) => {
    // Safely access env var or use passed key
    const envKey = typeof process !== 'undefined' && process.env ? process.env.API_KEY : '';
    
    const config: any = { 
        apiKey: apiKey || envKey
    };

    // Only set baseUrl if provided and not empty
    if (baseUrl && baseUrl.trim().length > 0) {
        config.baseUrl = baseUrl;
    }
    
    return new GoogleGenAI(config);
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

export const analyzeStoryText = async (fullText: string, apiKey: string, baseUrl?: string): Promise<GeneratedScene[]> => {
  const ai = getAiClient(apiKey, baseUrl);
  
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
const compressImage = async (imageUrlOrBase64: string, maxSizeBytes: number, maxWidth: number): Promise<string> => {
    return new Promise((resolve) => {
        const img = new Image();
        // Enable CORS for external images
        img.crossOrigin = "Anonymous"; 
        
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
                resolve(imageUrlOrBase64); // Fail safe
                return;
            }
            
            // Draw image to canvas
            try {
                ctx.drawImage(img, 0, 0, width, height);

                // Iterative compression
                let quality = maxSizeBytes > 100 * 1024 ? 0.95 : 0.8;
                let dataUrl = canvas.toDataURL('image/jpeg', quality);
                
                while (dataUrl.length * 0.75 > maxSizeBytes && quality > 0.1) {
                    quality -= 0.1;
                    dataUrl = canvas.toDataURL('image/jpeg', quality);
                }

                resolve(dataUrl);
            } catch (e) {
                // Canvas tainted (CORS) or other error
                console.warn("Compression failed (likely CORS), returning original URL", e);
                resolve(imageUrlOrBase64);
            }
        };
        
        img.onerror = () => {
            console.warn("Image load failed for compression, returning original");
            resolve(imageUrlOrBase64);
        };
        
        img.src = imageUrlOrBase64;
    });
};

// New function for OpenAI-compatible endpoints (like NewCoin)
const generateImageViaOpenAICompat = async (prompt: string, apiKey: string, baseUrl: string, maxSizeBytes: number, maxWidth: number): Promise<string> => {
    const url = `${baseUrl}/v1/chat/completions`;
    
    const payload = {
        max_tokens: 4096,
        model: "gemini-2.0-flash-exp-image-generation",
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: prompt
                    }
                ]
            }
        ]
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`NewCoin API Error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("No content in NewCoin response");
    }

    // Extract URL from markdown or raw text
    // Pattern 1: Markdown image ![alt](https://...)
    // Pattern 2: Raw https://...
    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    
    if (urlMatch && urlMatch[0]) {
        // Compress potentially large external images
        return await compressImage(urlMatch[0], maxSizeBytes, maxWidth);
    } else {
        throw new Error("No image URL found in response content");
    }
};

export const generateImageForScene = async (
    prompt: string, 
    apiKey: string, 
    sceneId: number, 
    isRetry: boolean = false, 
    attempt: number = 1, 
    baseUrl: string = '',
    apiProvider: 'official' | 'newcoin' | 'custom' = 'official'
): Promise<string> => {
  
  // Determine compression targets based on Scene ID
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
    // -------------------------------------------------------
    // ROUTING LOGIC: Choose Provider
    // -------------------------------------------------------
    
    if (apiProvider === 'newcoin') {
        // Use OpenAI Compatible endpoint for NewCoin
        // Ensure we have a baseUrl, default to NewCoin's if empty (though App.tsx should handle this)
        const targetUrl = baseUrl || 'https://api.newcoin.top';
        return await generateImageViaOpenAICompat(finalPrompt, apiKey, targetUrl, maxSizeBytes, maxWidth);
    } 
    else {
        // Use Standard Google SDK (Official or Custom Proxy compatible with Google Protocol)
        const ai = getAiClient(apiKey, baseUrl);
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
            
            const isSafety = reason.includes('SAFETY') || reason === 'RECITATION' || reason === 'OTHER' || reason.includes('BLOCK');
            
            if (isSafety) {
                 if (!isRetry) {
                     console.warn(`Safety filter (${reason}) triggered. Retrying with sanitized prompt...`);
                     // Recursively call self with retry flag
                     return await generateImageForScene(prompt, apiKey, sceneId, true, 1, baseUrl, apiProvider);
                 } else {
                     const ultraSafePrompt = "Abstract cinematic composition, soft lighting, asian style, emotional atmosphere, blurry background";
                     if (!prompt.includes("Abstract cinematic composition")) {
                        console.warn(`Sanitized prompt also failed (${reason}). Retrying with ULTRA SAFE fallback...`);
                        return await generateImageForScene(ultraSafePrompt, apiKey, sceneId, true, 1, baseUrl, apiProvider);
                     }
                 }
            }
            throw new Error(msg);
        }

        const parts = candidate.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
             const rawBase64 = `data:image/png;base64,${part.inlineData.data}`;
             return await compressImage(rawBase64, maxSizeBytes, maxWidth);
          }
        }
        
        if (!isRetry) {
             console.warn("No image data found. Retrying with sanitized prompt...");
             return await generateImageForScene(prompt, apiKey, sceneId, true, 1, baseUrl, apiProvider);
        }
        
        throw new Error("No image data found in response");
    }

  } catch (error: any) {
    // Rate limit handling
    if (error.status === 'RESOURCE_EXHAUSTED' || error.code === 429 || (error.message && error.message.includes('429'))) {
        if (attempt <= 1) { 
            console.warn(`Rate limit hit (429). Throwing for key switch...`);
            const quotaError = new Error("QUOTA_EXCEEDED");
            (quotaError as any).code = 429;
            throw quotaError;
        }
    }

    // Catch-all for retries
    if (!isRetry && (error.message?.includes('SAFETY') || error.message?.includes('PERMISSION_DENIED') || error.message?.includes('400') || error.message?.includes('403'))) {
         console.warn("Safety/Permission/API error caught. Retrying with sanitized prompt...");
         return await generateImageForScene(prompt, apiKey, sceneId, true, 1, baseUrl, apiProvider);
    }

    console.error("Image generation failed:", error);
    throw error;
  }
};