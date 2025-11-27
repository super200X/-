import React, { useEffect, useRef } from 'react';
import { GeneratedScene, RenderedResult, ArticlePreviewProps } from '../types';

declare global {
  interface Window {
    marked: {
      parse: (text: string) => string;
    };
  }
}

// Robustly finds the start index of the line that begins with "01", "1.", "Section 1", etc.
const findBeforeSectionOneIndex = (text: string): number => {
  let currentIndex = 0;
  // Split by newline to scan line by line. 
  // Note: split/join logic handles standard newlines.
  const lines = text.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    const rawLineLength = line.length + 1; // +1 accounts for the \n character consumed by split
    
    // We look for lines that START with "01", "1.", "Section 1", "Chapter 1", "第一章"
    const isSectionOne = 
        /^#{0,3}\s*0?1(\s|\.|$)/.test(trimmed) || 
        /^#{0,3}\s*section\s*1\b/.test(trimmed) ||
        /^#{0,3}\s*chapter\s*1\b/.test(trimmed) ||
        /^#{0,3}\s*第一章/.test(trimmed) ||
        /^#{0,3}\s*正文/.test(trimmed);

    if (isSectionOne) {
        // If found, we return 'currentIndex', which is the start of this line.
        // Inserting here puts the content on the line ABOVE this header.
        // We add a check (> 50 chars) to ensure we don't accidentally match the main article title if it starts with "01".
        if (currentIndex > 50) {
            return currentIndex;
        }
    }
    
    currentIndex += rawLineLength;
  }
  
  // Fallback: End of intro markers logic
  const lowerText = text.toLowerCase();
  const introMarkers = ['## 引言', '## 序章', '## introduction'];
  for (const marker of introMarkers) {
    const startIdx = lowerText.indexOf(marker);
    if (startIdx > -1) {
      // If we found Intro, try to find the NEXT header after it
      const searchFrom = startIdx + marker.length;
      const slice = text.slice(searchFrom);
      const nextHeaderRegex = /^##\s/m;
      const nextMatch = nextHeaderRegex.exec(slice);
      if (nextMatch) {
        return searchFrom + nextMatch.index;
      }
    }
  }

  // Final Fallback: 15% mark
  return Math.floor(text.length * 0.15);
};

export const ArticlePreview: React.FC<ArticlePreviewProps> = ({ fullText, scenes, onResultReady, onRegenerate }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Function to bind click events to the injected buttons after render
  const bindEvents = () => {
    if (!containerRef.current) return;
    
    // Bind Regenerate Buttons
    const regenButtons = containerRef.current.querySelectorAll('.regen-btn');
    regenButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const sceneId = parseInt((e.target as HTMLElement).getAttribute('data-id') || '0');
            if (sceneId) onRegenerate(sceneId);
        });
    });
  };

  useEffect(() => {
    if (!fullText) return;

    let modifiedMarkdown = fullText;
    
    // Filter for scenes that are EITHER completed OR error OR generating (we need placeholders)
    const validScenes = scenes
      .filter(s => s.status !== 'pending')
      .sort((a, b) => a.id - b.id);

    let lastInsertIndex = 0;
    const sectionOneStart = findBeforeSectionOneIndex(fullText);
    let insertionOffset = 0;

    // Dictionaries to store the HTML replacements
    const interactiveReplacements: Record<string, string> = {};
    const cleanReplacements: Record<string, string> = {};

    validScenes.forEach((scene, index) => {
      // 1. Interactive HTML (With Buttons, Tailwind classes)
      let interactiveHtml = '';
      // 2. Clean HTML (For Download - Image Only, Inline Styles)
      let cleanHtml = '';
      
      if (scene.status === 'completed' && scene.imageUrl) {
          interactiveHtml = `
<div class="my-8 relative group rounded-lg overflow-hidden shadow-lg">
    <img src="${scene.imageUrl}" alt="Scene ${scene.id}" class="w-full h-auto block" />
    <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <button data-id="${scene.id}" class="regen-btn bg-white/90 hover:bg-white text-indigo-900 font-bold py-2 px-6 rounded-full shadow-lg transform hover:scale-105 transition-all">
            🔄 重新生成此图
        </button>
    </div>
    <div class="absolute bottom-2 right-2 text-xs text-white/50 opacity-0 group-hover:opacity-100 bg-black/50 px-2 rounded">
       场景 ${scene.id}
    </div>
</div>`;

          // Clean HTML: Just the image, centered, max-width
          cleanHtml = `
<div style="margin: 2em 0; text-align: center;">
    <img src="${scene.imageUrl}" alt="Illustration" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); display: block; margin: 0 auto;" />
</div>`;

      } else if (scene.status === 'error') {
          interactiveHtml = `
<div class="my-8 p-8 border-2 border-red-200 bg-red-50 rounded-lg flex flex-col items-center justify-center text-center">
    <div class="text-red-500 font-bold mb-2">生成失败</div>
    <div class="text-xs text-gray-500 mb-4 max-w-md">AI 无法生成此场景（可能是由于安全策略或 API 错误）。</div>
    <button data-id="${scene.id}" class="regen-btn bg-red-100 hover:bg-red-200 text-red-700 font-bold py-2 px-4 rounded transition-colors">
        ⚠️ 重试生成
    </button>
</div>`;
          // Clean HTML: Empty for errors
          cleanHtml = ``; 
      } else if (scene.status === 'generating') {
          interactiveHtml = `
<div class="my-8 p-12 border-2 border-indigo-100 bg-indigo-50 rounded-lg flex flex-col items-center justify-center animate-pulse">
    <div class="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
    <div class="text-indigo-800 font-medium">正在生成场景 ${scene.id}...</div>
</div>`;
          cleanHtml = ``;
      }

      const token = `<!--IMAGE_SCENE_${scene.id}-->`;
      interactiveReplacements[token] = interactiveHtml;
      cleanReplacements[token] = cleanHtml;

      const quote = scene.quote.trim();
      let injected = false;
      let matchIndex = -1;
      
      if (scene.id === 1) {
          // Scene 1 strictly uses the calculated sectionOneStart logic
          matchIndex = sectionOneStart + insertionOffset;
          
          // Bounds check
          if (matchIndex < 0) matchIndex = 0;
          if (matchIndex > modifiedMarkdown.length) matchIndex = Math.floor(modifiedMarkdown.length * 0.15);
          
          injected = true;
      } else {
          // Scenes 2-6: Try to find the exact quote
          const exactIdx = modifiedMarkdown.indexOf(quote, lastInsertIndex);
          if (exactIdx !== -1) {
            matchIndex = exactIdx + quote.length;
            injected = true;
          } else {
             // Fuzzy Match
            const words = quote.split(/[^\w\u4e00-\u9fa5]+/).filter(w => w.length > 1);
            if (words.length > 0) {
                const pattern = words.slice(0, 5).map(w => w.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('.{0,50}');
                try {
                    const searchSlice = modifiedMarkdown.slice(lastInsertIndex);
                    const regex = new RegExp(pattern, 'm');
                    const match = regex.exec(searchSlice);
                    if (match) {
                        matchIndex = lastInsertIndex + match.index + match[0].length;
                        injected = true;
                    }
                } catch (e) {}
            }
          }
      }

      // Insert Token into Markdown
      if (injected && matchIndex !== -1) {
        modifiedMarkdown = modifiedMarkdown.slice(0, matchIndex) + `\n${token}\n` + modifiedMarkdown.slice(matchIndex);
        lastInsertIndex = matchIndex + token.length + 2;
        insertionOffset += token.length + 2;
      }
      else {
         // Fallback distribution for scenes 2-6 if quote not found
         const currentLength = modifiedMarkdown.length;
         const remainingSpace = currentLength - lastInsertIndex;
         const scenesRemaining = validScenes.length - index;
         const chunk = Math.floor(remainingSpace / (scenesRemaining + 1));
         let targetIndex = lastInsertIndex + chunk;
         
         // Try to snap to a newline
         const nextNewline = modifiedMarkdown.indexOf('\n', targetIndex);
         if (nextNewline !== -1 && nextNewline - targetIndex < 500) targetIndex = nextNewline;

         modifiedMarkdown = modifiedMarkdown.slice(0, targetIndex) + `\n${token}\n` + modifiedMarkdown.slice(targetIndex);
         lastInsertIndex = targetIndex + token.length + 2;
         insertionOffset += token.length + 2;
      }
    });

    // Parse Markdown to HTML
    const rawHtml = window.marked.parse(modifiedMarkdown);
    let interactiveResult = rawHtml;
    let cleanResult = rawHtml;

    // Replace Tokens
    scenes.forEach(scene => {
        const token = `<!--IMAGE_SCENE_${scene.id}-->`;
        // Markdown parser might wrap comments in <p>, so regex replace needed
        const regex = new RegExp(`(<p>\\s*)?${token}(\\s*<\\/p>)?`, 'g');
        
        interactiveResult = interactiveResult.replace(regex, interactiveReplacements[token] || '');
        cleanResult = cleanResult.replace(regex, cleanReplacements[token] || '');
    });
    
    onResultReady({
      markdownWithImages: modifiedMarkdown,
      htmlContent: interactiveResult,
      cleanHtmlContent: cleanResult
    });

    if (containerRef.current) {
      containerRef.current.innerHTML = interactiveResult;
      bindEvents();
    }

  }, [fullText, scenes, onResultReady]);

  // Re-bind events if the DOM updates
  useEffect(() => {
     bindEvents();
  });

  return (
    <div className="w-full max-w-4xl mx-auto bg-white shadow-2xl min-h-[140vh] p-12 md:p-20 relative">
      <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>
      
      <div 
        ref={containerRef} 
        className="prose prose-lg prose-indigo max-w-none font-serif text-gray-800 leading-loose"
      />

      <div className="mt-20 pt-10 border-t border-gray-100 text-center text-gray-400 italic text-sm font-sans">
        由 StoryVisualizer AI 生成
      </div>
    </div>
  );
};