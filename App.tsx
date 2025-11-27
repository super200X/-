import React, { useState, useRef } from 'react';
import { GeneratedScene, ProcessingState, RenderedResult } from './types';
import { analyzeStoryText, generateImageForScene } from './services/geminiService';
import { ArticlePreview } from './components/ArticlePreview';

declare global {
  interface Window {
    TurndownService: any;
    mammoth: any;
    marked: {
      parse: (text: string) => string;
    };
  }
}

const App: React.FC = () => {
  const [markdownText, setMarkdownText] = useState<string>('');
  const [inputMode, setInputMode] = useState<'edit' | 'preview'>('edit');
  const [scenes, setScenes] = useState<GeneratedScene[]>([]);
  const [processing, setProcessing] = useState<ProcessingState>({
    stage: 'idle',
    progressMessage: '',
    totalScenes: 0,
    completedScenes: 0
  });
  const [finalResult, setFinalResult] = useState<RenderedResult | null>(null);
  
  // API Key State Management
  // Safe access for process.env to avoid ReferenceError in browser
  const [currentApiKey, setCurrentApiKey] = useState<string>(
      typeof process !== 'undefined' && process.env && process.env.API_KEY ? process.env.API_KEY : ''
  );
  const [showRateLimitModal, setShowRateLimitModal] = useState<boolean>(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);
  const [retryStartIndex, setRetryStartIndex] = useState<number>(0);
  const [newKeyInput, setNewKeyInput] = useState<string>('');

  // Loading Video State
  const [loadingVideoSrc, setLoadingVideoSrc] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingVideoInputRef = useRef<HTMLInputElement>(null);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // If Turndown is available, try to convert HTML clipboard to Markdown
    const htmlData = e.clipboardData.getData('text/html');
    
    if (htmlData && window.TurndownService) {
      e.preventDefault();
      try {
        const turndownService = new window.TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced'
        });
        const markdown = turndownService.turndown(htmlData);
        
        // Insert at cursor
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const before = text.substring(0, start);
        const after = text.substring(end);
        
        const newText = before + markdown + after;
        setMarkdownText(newText);
        
        // Restore cursor position (approximate)
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.value = newText;
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + markdown.length;
          }
        }, 0);
      } catch (err) {
        console.warn("Rich text conversion failed, falling back to plain text", err);
        const plainText = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, plainText);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check extension
    if (file.name.toLowerCase().endsWith('.doc')) {
        alert("浏览器暂不支持旧版 .doc 文件，请另存为 .docx 后重试。");
        return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
        const arrayBuffer = event.target?.result as ArrayBuffer;
        
        if (window.mammoth) {
            try {
                const result = await window.mammoth.convertToHtml({ arrayBuffer });
                const html = result.value; // The generated HTML
                
                // Convert to Markdown using Turndown
                if (window.TurndownService) {
                    const turndownService = new window.TurndownService({
                        headingStyle: 'atx',
                        codeBlockStyle: 'fenced'
                    });
                    const markdown = turndownService.turndown(html);
                    setMarkdownText(markdown);
                } else {
                    // Fallback to basic text if turndown fails/missing
                    alert("Markdown 转换器丢失，将作为纯文本加载。");
                    setMarkdownText(result.value.replace(/<[^>]*>/g, ''));
                }

                // Warn about messages if any
                if (result.messages && result.messages.length > 0) {
                    console.log("Mammoth messages:", result.messages);
                }
            } catch (err) {
                console.error("Error parsing Word file:", err);
                alert("解析 Word 文件失败，请确保是有效的 .docx 文件。");
            }
        }
    };
    reader.readAsArrayBuffer(file);
    
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleLoadingVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
        const url = URL.createObjectURL(file);
        setLoadingVideoSrc(url);
    }
    if (loadingVideoInputRef.current) loadingVideoInputRef.current.value = '';
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  // Start processing, optionally resuming from a specific scene index
  const startProcessing = async (resumeFromIndex: number = 0) => {
    if (!markdownText.trim()) return;
    
    // Check if we have a key (either from env or manually set)
    if (!currentApiKey) {
        setShowApiKeyModal(true);
        return;
    }

    // Only reset scenes if we are starting from scratch
    if (resumeFromIndex === 0) {
        setProcessing({
          stage: 'analyzing',
          progressMessage: '正在阅读故事结构并识别情绪高潮...',
          totalScenes: 0,
          completedScenes: 0
        });
        setScenes([]);
        setFinalResult(null);
    } else {
        // Resuming
        setProcessing(prev => ({
            ...prev,
            stage: 'generating',
            progressMessage: '正在恢复生成...'
        }));
    }

    try {
      let plannedScenes: GeneratedScene[] = [];

      // 1. Analysis (Only if starting from scratch)
      if (resumeFromIndex === 0) {
          try {
              plannedScenes = await analyzeStoryText(markdownText, currentApiKey);
              setScenes(plannedScenes);
              
              setProcessing({
                stage: 'generating',
                progressMessage: '正在启动视觉引擎...',
                totalScenes: plannedScenes.length,
                completedScenes: 0
              });
          } catch (e: any) {
              // Handle Rate Limit during Analysis
              if (e.code === 429 || e.message?.includes('429') || e.message?.includes('QUOTA')) {
                  setRetryStartIndex(0); // Restart analysis
                  setShowRateLimitModal(true);
                  return;
              }
              throw e;
          }
      } else {
          // Use existing scenes if resuming
          plannedScenes = [...scenes];
      }

      // 2. Generation Loop
      const updatedScenes = [...plannedScenes];
      
      // Start loop from resumeFromIndex
      for (let i = resumeFromIndex; i < updatedScenes.length; i++) {
        const scene = updatedScenes[i];
        
        // Skip if already completed (double check)
        if (scene.status === 'completed') continue;

        // Update UI
        updatedScenes[i] = { ...scene, status: 'generating' };
        setScenes([...updatedScenes]);
        setProcessing(prev => ({
          ...prev,
          progressMessage: `正在绘制场景 ${scene.id}: ${scene.reasoning}...`,
          completedScenes: i
        }));

        // ADD DELAY: Wait 10 seconds before next request to avoid Rate Limit (429)
        // Skip delay if it's the very first request of this batch
        if (i > resumeFromIndex) {
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        try {
          // Pass scene.id to enable quality control (Scene 1 = High Quality, Others = 50KB)
          const imageUrl = await generateImageForScene(scene.visualPrompt, currentApiKey, scene.id);
          updatedScenes[i] = { ...scene, status: 'completed', imageUrl };
        } catch (e: any) {
          console.error(e);
          
          // INTERCEPT RATE LIMIT ERROR (429)
          if (e.code === 429 || e.message?.includes('QUOTA') || e.message?.includes('429')) {
              // Pause execution here
              updatedScenes[i] = { ...scene, status: 'pending' }; // Revert to pending
              setScenes([...updatedScenes]);
              
              setRetryStartIndex(i); // Save the index to resume from
              setShowRateLimitModal(true); // Open Modal
              return; // EXIT THE FUNCTION (Loop stops)
          }

          updatedScenes[i] = { ...scene, status: 'error' };
        }
        
        // Update state
        setScenes([...updatedScenes]);
      }

      setProcessing({
        stage: 'complete',
        progressMessage: '完成！',
        totalScenes: updatedScenes.length,
        completedScenes: updatedScenes.length
      });

    } catch (error) {
      console.error(error);
      setProcessing(prev => ({ ...prev, stage: 'error', progressMessage: '处理故事失败。' }));
    }
  };

  const handleResumeWithNewKey = () => {
      if (!newKeyInput.trim()) return;
      setCurrentApiKey(newKeyInput.trim());
      setShowRateLimitModal(false);
      setNewKeyInput('');
      
      // Resume processing from the saved index
      startProcessing(retryStartIndex);
  };
  
  const handleSaveInitialKey = () => {
      if (!newKeyInput.trim()) return;
      setCurrentApiKey(newKeyInput.trim());
      setShowApiKeyModal(false);
      setNewKeyInput('');
  };

  const handleRegenerateScene = async (sceneId: number) => {
    if (!currentApiKey) return;

    const sceneIndex = scenes.findIndex(s => s.id === sceneId);
    if (sceneIndex === -1) return;

    const newScenes = [...scenes];
    const scene = newScenes[sceneIndex];
    
    // Set status to generating
    newScenes[sceneIndex] = { ...scene, status: 'generating' };
    setScenes(newScenes);

    try {
        // Regenerate image with retry flag true, and pass scene.id for quality settings
        const imageUrl = await generateImageForScene(scene.visualPrompt, currentApiKey, scene.id, true);
        newScenes[sceneIndex] = { ...scene, status: 'completed', imageUrl };
    } catch (e: any) {
        console.error("Regeneration failed:", e);
        
        // Handle Rate Limit during Regeneration too
        if (e.code === 429 || e.message?.includes('QUOTA') || e.message?.includes('429')) {
             newScenes[sceneIndex] = { ...scene, status: 'error' }; // Temporarily error
             setScenes([...newScenes]);
             
             // We can't easily auto-resume a single click handler, but we can ask for the key
             // so the user can click regenerate AGAIN successfully.
             setRetryStartIndex(-1); // Indicator that we are not in the main loop
             setShowRateLimitModal(true);
             return;
        }

        newScenes[sceneIndex] = { ...scene, status: 'error' };
    }

    setScenes([...newScenes]);
  };

  const downloadHtml = () => {
    if (!finalResult) return;

    const lines = markdownText.split('\n');
    const firstLine = lines.find(l => l.trim().length > 0);
    const title = firstLine ? firstLine.replace(/^([#*>_~`\s-]+)/, '').trim() : 'Illustrated Story';

    const cleanFilename = (title
      .replace(/[<>:"/\\|?*]/g, '') 
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100) || 'story') + '.html';

    // Use cleanHtmlContent for the downloadable file
    const htmlTemplate = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link href="https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,300;0,400;0,700;1,400&family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Merriweather', serif; line-height: 1.8; color: #1a202c; background: #f7fafc; padding: 40px 20px; }
        .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 60px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-radius: 8px; }
        h1, h2, h3 { font-family: 'Inter', sans-serif; color: #2d3748; }
        h1 { font-size: 2.5rem; margin-bottom: 0.5rem; line-height: 1.2; }
        img { max-width: 100%; height: auto; border-radius: 4px; margin: 2rem 0; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); }
        blockquote { border-left: 4px solid #cbd5e0; padding-left: 1rem; color: #4a5568; font-style: italic; }
        strong { font-weight: 700; color: #1a202c; }
    </style>
</head>
<body>
    <div class="container">
        ${finalResult.cleanHtmlContent}
    </div>
</body>
</html>`;

    const blob = new Blob([htmlTemplate], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = cleanFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- RENDER ---

  // 1. Editor View
  if (processing.stage === 'idle') {
    return (
      <div className="h-screen w-full bg-gray-50 flex flex-col overflow-hidden relative">
        {/* Web Header */}
        <header className="bg-indigo-900 text-white h-16 shrink-0 shadow-lg flex justify-between items-center px-6 z-10 relative">
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-lg flex items-center justify-center font-bold text-white shadow-inner">SV</div>
                <div>
                    <h1 className="text-xl font-bold tracking-tight hidden md:block">故事配图 AI (StoryVisualizer)</h1>
                </div>
            </div>
            
            <div className="flex items-center gap-3">
                {/* File Upload Input (Word) */}
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    accept=".docx,.doc" 
                    onChange={handleFileSelect}
                />
                {/* File Upload Input (Video) */}
                <input 
                    type="file" 
                    ref={loadingVideoInputRef} 
                    className="hidden" 
                    accept="video/*" 
                    onChange={handleLoadingVideoSelect}
                />
                
                <button 
                  onClick={() => setShowApiKeyModal(true)}
                  className="text-indigo-200 hover:text-white p-2 rounded hover:bg-indigo-800 transition-colors"
                  title="配置 API Key"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>

                <button 
                  onClick={() => loadingVideoInputRef.current?.click()}
                  className="bg-indigo-800 hover:bg-indigo-700 text-indigo-200 hover:text-white px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2"
                >
                  <span className="text-lg">🎬</span>
                  <span className="hidden sm:inline">设置加载视频</span>
                </button>

                <button 
                  onClick={triggerFileUpload}
                  className="bg-indigo-800 hover:bg-indigo-700 text-indigo-100 px-3 py-1.5 rounded-md text-xs font-medium transition-all border border-indigo-700 hover:border-indigo-500 flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>上传 .docx</span>
                </button>

                <div className="h-6 w-px bg-indigo-800 mx-2 hidden md:block"></div>

                <div className="bg-indigo-800 p-1 rounded-lg flex text-xs font-medium">
                  <button
                    onClick={() => setInputMode('edit')}
                    className={`px-3 py-1.5 rounded-md transition-all ${inputMode === 'edit' ? 'bg-white text-indigo-900 shadow-sm' : 'text-indigo-200 hover:text-white'}`}
                  >
                    编辑器
                  </button>
                  <button
                    onClick={() => setInputMode('preview')}
                    className={`px-3 py-1.5 rounded-md transition-all ${inputMode === 'preview' ? 'bg-white text-indigo-900 shadow-sm' : 'text-indigo-200 hover:text-white'}`}
                  >
                    预览
                  </button>
                </div>
                
                <button 
                  onClick={() => startProcessing(0)}
                  disabled={!markdownText.trim()}
                  className="bg-indigo-500 hover:bg-indigo-400 disabled:bg-indigo-800 disabled:text-indigo-400 text-white px-4 md:px-6 py-2 rounded-md text-sm font-semibold transition-all shadow-md flex items-center gap-2 ml-2"
                >
                  <span className="hidden md:inline">生成配图</span>
                  <span className="md:hidden">生成</span>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
            </div>
        </header>

        {/* API Key Modal (Initial Setup or Change) */}
        {showApiKeyModal && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center backdrop-blur-sm">
            <div className="bg-white rounded-lg shadow-2xl p-6 w-full max-w-md animate-bounce-in">
              <h3 className="text-xl font-bold text-gray-800 mb-4">配置 Google AI API Key</h3>
              <p className="text-sm text-gray-500 mb-4">
                本应用运行在您的浏览器本地，不会上传您的数据。您需要提供自己的 Google API Key 才能调用 Gemini 模型。
              </p>
              <div className="mb-4">
                <input 
                  type="password"
                  className="w-full border border-gray-300 rounded-md px-4 py-2 focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="粘贴您的 API Key (AI Studio)"
                  value={newKeyInput}
                  onChange={(e) => setNewKeyInput(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-3">
                 <button 
                    onClick={() => setShowApiKeyModal(false)}
                    className="text-gray-500 hover:text-gray-700 px-3 py-2 text-sm"
                 >
                    取消
                 </button>
                 <button 
                    onClick={handleSaveInitialKey}
                    disabled={!newKeyInput.trim()}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white px-4 py-2 rounded-md font-medium transition-colors"
                 >
                    保存并继续
                 </button>
              </div>
              <div className="mt-4 text-xs text-gray-400 text-center">
                 API Key 仅保存在内存中，刷新页面后需重新输入。
                 <br />
                 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-indigo-500 hover:underline">获取 API Key →</a>
              </div>
            </div>
          </div>
        )}

        {/* Main Workspace */}
        <main className="flex-1 overflow-hidden relative flex flex-col items-center">
            {/* Document Container */}
            <div className="w-full max-w-5xl h-full bg-white shadow-xl flex flex-col border-x border-gray-200 overflow-hidden">
                {/* Toolbar / Hint */}
                <div className="bg-gray-50 border-b border-gray-100 px-8 py-2 text-xs text-gray-400 flex justify-between">
                    <span>支持 Markdown, 富文本 和 .docx 文档</span>
                    <span>{markdownText.length} 字</span>
                </div>

                {inputMode === 'edit' ? (
                  <textarea
                    ref={textareaRef}
                    className="flex-1 w-full p-12 text-lg font-mono text-gray-800 resize-none focus:outline-none leading-relaxed"
                    placeholder="# 文章标题\n\n## 引言\n在此粘贴您的故事或上传 .docx 文件..."
                    value={markdownText}
                    onChange={(e) => setMarkdownText(e.target.value)}
                    onPaste={handlePaste}
                  />
                ) : (
                  <div className="flex-1 w-full overflow-y-auto bg-white p-12">
                     <div className="prose prose-lg prose-indigo max-w-none font-serif text-gray-800 leading-loose">
                        <div dangerouslySetInnerHTML={{ __html: window.marked ? window.marked.parse(markdownText) : markdownText }} />
                     </div>
                  </div>
                )}
            </div>
        </main>
      </div>
    );
  }

  // 2. Result View (Complete)
  if (processing.stage === 'complete') {
      return (
          <div className="min-h-screen bg-gray-50 flex flex-col">
              <header className="bg-indigo-900 text-white h-16 shrink-0 shadow-lg flex justify-between items-center px-6 sticky top-0 z-50">
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center font-bold text-white">✓</div>
                    <h1 className="text-xl font-bold tracking-tight">生成完成</h1>
                </div>
                <div className="flex gap-3">
                    <button 
                        onClick={() => {
                            setProcessing(prev => ({ ...prev, stage: 'idle' }));
                            setFinalResult(null);
                        }}
                        className="text-gray-300 hover:text-white px-4 py-2 text-sm font-medium"
                    >
                        返回编辑
                    </button>
                    <button 
                        onClick={downloadHtml}
                        className="bg-green-500 hover:bg-green-400 text-white px-6 py-2 rounded-md text-sm font-bold shadow-md transition-all flex items-center gap-2"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                        下载 HTML
                    </button>
                </div>
              </header>
              
              <div className="flex-1 overflow-auto py-8">
                  <ArticlePreview 
                    fullText={markdownText} 
                    scenes={scenes}
                    onResultReady={setFinalResult}
                    onRegenerate={handleRegenerateScene}
                  />
              </div>

              {/* Keep Modal in case regeneration triggers 429 */}
              {showRateLimitModal && (
                  <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center backdrop-blur-sm">
                      <div className="bg-white text-gray-900 p-8 rounded-lg shadow-2xl max-w-md w-full">
                          <h3 className="text-xl font-bold text-red-600 mb-4">API 配额耗尽 (重新生成)</h3>
                          <p className="text-gray-600 mb-6">请输入新的 Key 以继续操作。</p>
                          <input 
                              type="password" 
                              className="w-full border border-gray-300 rounded px-3 py-2 mb-4"
                              placeholder="New API Key..."
                              value={newKeyInput}
                              onChange={e => setNewKeyInput(e.target.value)}
                          />
                          <div className="flex justify-end gap-2">
                               <button onClick={() => setShowRateLimitModal(false)} className="px-3 py-1 text-gray-500">Cancel</button>
                               <button onClick={() => { setCurrentApiKey(newKeyInput); setShowRateLimitModal(false); }} className="bg-indigo-600 text-white px-4 py-1 rounded">Update Key</button>
                          </div>
                      </div>
                  </div>
              )}
          </div>
      );
  }

  // 3. Loading View (Generating / Analyzing)
  return (
    <div className="h-screen w-full bg-gray-900 text-white flex flex-col items-center justify-center p-8 relative overflow-hidden">
      
      {/* Rate Limit Rescue Modal */}
      {showRateLimitModal && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center backdrop-blur-sm">
              <div className="bg-white text-gray-900 p-8 rounded-lg shadow-2xl max-w-md w-full animate-bounce-in">
                  <div className="flex items-center gap-3 text-red-600 mb-4">
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                       </svg>
                       <h3 className="text-xl font-bold">API 配额已耗尽 (429)</h3>
                  </div>
                  <p className="text-gray-600 mb-6">
                      您的 Google AI 账户生图配额已用完。请更换一个新的 API Key 以继续生成，否则当前进度将停止。
                  </p>
                  
                  <div className="mb-6">
                      <label className="block text-sm font-medium text-gray-700 mb-2">新的 Google AI API Key</label>
                      <input 
                          type="password" 
                          className="w-full border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none"
                          placeholder="粘贴新的 Key..."
                          value={newKeyInput}
                          onChange={e => setNewKeyInput(e.target.value)}
                      />
                  </div>

                  <div className="flex justify-end gap-3">
                      <button 
                          onClick={() => {
                              setShowRateLimitModal(false); 
                              setProcessing(prev => ({...prev, stage: 'error', progressMessage: '已取消操作'}));
                          }}
                          className="px-4 py-2 text-gray-500 hover:text-gray-700"
                      >
                          取消
                      </button>
                      <button 
                          onClick={handleResumeWithNewKey}
                          disabled={!newKeyInput.trim()}
                          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white px-4 py-2 rounded shadow transition-colors"
                      >
                          更换并继续生成
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Animated Background */}
      <div className="absolute inset-0 z-0 opacity-20">
        <div className="absolute top-0 -left-4 w-96 h-96 bg-purple-600 rounded-full mix-blend-multiply filter blur-3xl animate-blob"></div>
        <div className="absolute top-0 -right-4 w-96 h-96 bg-yellow-600 rounded-full mix-blend-multiply filter blur-3xl animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-8 left-20 w-96 h-96 bg-pink-600 rounded-full mix-blend-multiply filter blur-3xl animate-blob animation-delay-4000"></div>
      </div>

      <div className="z-10 text-center max-w-2xl w-full">
        <div className="mb-10">
          {/* CUSTOM LOADING VIDEO OR SPINNER */}
          {loadingVideoSrc ? (
            <div className="mb-8 relative mx-auto w-64 aspect-[9/16] md:aspect-video md:w-80 rounded-2xl overflow-hidden shadow-2xl shadow-indigo-500/50 border-4 border-indigo-500/20">
                <video 
                    src={loadingVideoSrc} 
                    autoPlay 
                    loop 
                    muted 
                    playsInline 
                    className="w-full h-full object-cover"
                />
            </div>
          ) : (
            <div className="w-20 h-20 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-8 shadow-lg shadow-indigo-500/50"></div>
          )}
          
          <h2 className="text-4xl font-bold mb-4 tracking-tight">我知道你很急但是先别急</h2>
          <p className="text-xl text-gray-300 animate-pulse font-light">{processing.progressMessage}</p>
        </div>

        {processing.totalScenes > 0 && (
            <div className="w-full bg-gray-800 rounded-full h-3 mb-4 overflow-hidden shadow-inner border border-gray-700">
                <div 
                className="bg-gradient-to-r from-indigo-500 to-purple-500 h-3 rounded-full transition-all duration-500 ease-out shadow-[0_0_10px_rgba(99,102,241,0.5)]" 
                style={{ width: `${Math.round((processing.completedScenes / processing.totalScenes) * 100)}%` }}
                ></div>
            </div>
        )}
        <div className="flex justify-between text-xs text-gray-500 uppercase tracking-widest font-semibold">
            <span className={processing.stage === 'analyzing' ? 'text-indigo-400' : ''}>剧本分析</span>
            <span className={processing.stage === 'generating' ? 'text-indigo-400' : ''}>视觉生成</span>
            <span className={processing.stage === 'complete' ? 'text-indigo-400' : ''}>排版布局</span>
        </div>
      </div>
    </div>
  );
};

export default App;