import React, { useState, useRef, useEffect } from 'react';
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
  const [currentApiKey, setCurrentApiKey] = useState<string>(
      typeof process !== 'undefined' && process.env && process.env.API_KEY ? process.env.API_KEY : ''
  );
  
  // Base URL / Provider State
  const [apiProvider, setApiProvider] = useState<'official' | 'newcoin' | 'custom'>('official');
  const [customBaseUrl, setCustomBaseUrl] = useState<string>('');

  const [showRateLimitModal, setShowRateLimitModal] = useState<boolean>(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState<boolean>(false);
  const [retryStartIndex, setRetryStartIndex] = useState<number>(0);
  const [newKeyInput, setNewKeyInput] = useState<string>('');
  
  // Cooldown State
  const [cooldownTime, setCooldownTime] = useState<number>(0);

  // Loading Video State
  const [loadingVideoSrc, setLoadingVideoSrc] = useState<string | null>('loading.mp4');
  const [isVideoMissing, setIsVideoMissing] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Determine effective base URL
  const getEffectiveBaseUrl = () => {
      if (apiProvider === 'newcoin') return 'https://api.newcoin.top';
      if (apiProvider === 'custom') return customBaseUrl;
      return ''; // Official
  };

  // Effect to verify video path on mount
  useEffect(() => {
     setLoadingVideoSrc('loading.mp4');
  }, []);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const htmlData = e.clipboardData.getData('text/html');
    if (htmlData && window.TurndownService) {
      e.preventDefault();
      try {
        const turndownService = new window.TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced'
        });
        const markdown = turndownService.turndown(htmlData);
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const before = text.substring(0, start);
        const after = text.substring(end);
        const newText = before + markdown + after;
        setMarkdownText(newText);
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.value = newText;
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + markdown.length;
          }
        }, 0);
      } catch (err) {
        console.warn("Rich text conversion failed", err);
        const plainText = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, plainText);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
                if (window.TurndownService) {
                    const turndownService = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
                    setMarkdownText(turndownService.turndown(result.value));
                } else {
                    alert("Markdown 转换器丢失，将作为纯文本加载。");
                    setMarkdownText(result.value.replace(/<[^>]*>/g, ''));
                }
            } catch (err) {
                console.error("Error parsing Word file:", err);
                alert("解析 Word 文件失败，请确保是有效的 .docx 文件。");
            }
        }
    };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  const startProcessing = async (resumeFromIndex: number = 0) => {
    if (!markdownText.trim()) return;
    if (!currentApiKey) {
        setShowApiKeyModal(true);
        return;
    }
    
    const baseUrl = getEffectiveBaseUrl();

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
        setProcessing(prev => ({ ...prev, stage: 'generating', progressMessage: '正在恢复生成...' }));
    }

    try {
      let plannedScenes: GeneratedScene[] = [];
      if (resumeFromIndex === 0) {
          try {
              // Analysis always uses Google SDK protocol (NewCoin supports this for text)
              // Note: NewCoin's /v1/chat/completions is specific for image gen, standard text gen usually works with SDK if baseUrl is set
              // If analysis fails with NewCoin via SDK, we might need to switch it too, but usually text works.
              plannedScenes = await analyzeStoryText(markdownText, currentApiKey, baseUrl);
              setScenes(plannedScenes);
              setProcessing({
                stage: 'generating',
                progressMessage: '正在启动视觉引擎...',
                totalScenes: plannedScenes.length,
                completedScenes: 0
              });
          } catch (e: any) {
              if (e.code === 429 || e.message?.includes('429') || e.message?.includes('QUOTA')) {
                  setRetryStartIndex(0);
                  setShowRateLimitModal(true);
                  return;
              }
              throw e;
          }
      } else {
          plannedScenes = [...scenes];
      }

      const updatedScenes = [...plannedScenes];
      for (let i = resumeFromIndex; i < updatedScenes.length; i++) {
        const scene = updatedScenes[i];
        if (scene.status === 'completed') continue;
        updatedScenes[i] = { ...scene, status: 'generating' };
        setScenes([...updatedScenes]);
        setProcessing(prev => ({
          ...prev,
          progressMessage: `正在绘制场景 ${scene.id}: ${scene.reasoning}...`,
          completedScenes: i
        }));

        try {
          // Pass apiProvider to generateImageForScene to choose correct method
          const imageUrl = await generateImageForScene(scene.visualPrompt, currentApiKey, scene.id, false, 1, baseUrl, apiProvider);
          updatedScenes[i] = { ...scene, status: 'completed', imageUrl };
        } catch (e: any) {
          console.error(e);
          if (e.code === 429 || e.message?.includes('QUOTA') || e.message?.includes('429')) {
              updatedScenes[i] = { ...scene, status: 'pending' };
              setScenes([...updatedScenes]);
              setCooldownTime(30);
              let remaining = 30;
              while (remaining > 0) {
                   setProcessing(prev => ({...prev, progressMessage: `API 冷却中 (等待免费配额重置)... ${remaining}s`}));
                   await wait(1000);
                   remaining--;
                   setCooldownTime(remaining);
              }
              setCooldownTime(0);
              i--; 
              continue;
          }
          updatedScenes[i] = { ...scene, status: 'error' };
        }
        setScenes([...updatedScenes]);
      }
      setProcessing({ stage: 'complete', progressMessage: '完成！', totalScenes: updatedScenes.length, completedScenes: updatedScenes.length });
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
    newScenes[sceneIndex] = { ...scene, status: 'generating' };
    setScenes(newScenes);
    try {
        const baseUrl = getEffectiveBaseUrl();
        // Pass apiProvider to regenerate as well
        const imageUrl = await generateImageForScene(scene.visualPrompt, currentApiKey, scene.id, true, 1, baseUrl, apiProvider);
        newScenes[sceneIndex] = { ...scene, status: 'completed', imageUrl };
    } catch (e: any) {
        console.error("Regeneration failed:", e);
        if (e.code === 429 || e.message?.includes('QUOTA') || e.message?.includes('429')) {
             newScenes[sceneIndex] = { ...scene, status: 'error' };
             setScenes([...newScenes]);
             setRetryStartIndex(-1);
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
    const cleanFilename = (title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().substring(0, 100) || 'story') + '.html';
    const htmlTemplate = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>body{font-family:serif;line-height:1.8;color:#1a202c;background:#f7fafc;padding:40px 20px}.container{max-width:800px;margin:0 auto;background:#fff;padding:60px;border-radius:8px}h1,h2,h3{font-family:sans-serif;color:#2d3748}img{max-width:100%;height:auto;margin:2rem 0}blockquote{border-left:4px solid #cbd5e0;padding-left:1rem;color:#4a5568;font-style:italic}</style>
</head>
<body><div class="container">${finalResult.cleanHtmlContent}</div></body></html>`;
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

  // 1. Editor View
  if (processing.stage === 'idle') {
    return (
      <div className="h-screen w-full bg-gray-50 flex flex-col overflow-hidden relative">
        <header className="bg-indigo-900 text-white h-16 shrink-0 shadow-lg flex justify-between items-center px-6 z-10 relative">
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-lg flex items-center justify-center font-bold text-white shadow-inner">SV</div>
                <h1 className="text-xl font-bold tracking-tight hidden md:block">故事配图 AI (StoryVisualizer)</h1>
            </div>
            <div className="flex items-center gap-3">
                <input type="file" ref={fileInputRef} className="hidden" accept=".docx,.doc" onChange={handleFileSelect} />
                
                <button onClick={() => setShowApiKeyModal(true)} className="text-indigo-200 hover:text-white p-2 rounded hover:bg-indigo-800 transition-colors" title="配置 API Key">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </button>

                <button onClick={triggerFileUpload} className="bg-indigo-800 hover:bg-indigo-700 text-indigo-100 px-3 py-1.5 rounded-md text-xs font-medium transition-all border border-indigo-700 hover:border-indigo-500 flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                  <span>上传 .docx</span>
                </button>

                <div className="bg-indigo-800 p-1 rounded-lg flex text-xs font-medium ml-2">
                  <button onClick={() => setInputMode('edit')} className={`px-3 py-1.5 rounded-md transition-all ${inputMode === 'edit' ? 'bg-white text-indigo-900 shadow-sm' : 'text-indigo-200 hover:text-white'}`}>编辑器</button>
                  <button onClick={() => setInputMode('preview')} className={`px-3 py-1.5 rounded-md transition-all ${inputMode === 'preview' ? 'bg-white text-indigo-900 shadow-sm' : 'text-indigo-200 hover:text-white'}`}>预览</button>
                </div>
                
                <button onClick={() => startProcessing(0)} disabled={!markdownText.trim()} className="bg-indigo-500 hover:bg-indigo-400 disabled:bg-indigo-800 disabled:text-indigo-400 text-white px-4 md:px-6 py-2 rounded-md text-sm font-semibold transition-all shadow-md flex items-center gap-2 ml-2">
                  <span className="hidden md:inline">生成配图</span><span className="md:hidden">生成</span>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </button>
            </div>
        </header>

        {showApiKeyModal && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center backdrop-blur-sm">
            <div className="bg-white rounded-lg shadow-2xl p-6 w-full max-w-md animate-bounce-in">
              <h3 className="text-xl font-bold text-gray-800 mb-4">配置 API 访问</h3>
              <p className="text-sm text-gray-500 mb-4">您可以选择直连 Google 官方接口，或使用 NewCoin 等中转服务来规避网络限制。</p>
              
              <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">API 线路</label>
                  <select 
                    value={apiProvider} 
                    onChange={(e) => setApiProvider(e.target.value as any)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                      <option value="official">Google 官方直连 (默认)</option>
                      <option value="newcoin">NewCoin 中转 (OpenAI 兼容)</option>
                      <option value="custom">自定义代理地址</option>
                  </select>
              </div>

              {apiProvider === 'custom' && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
                    <input type="text" className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="https://..." value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} />
                  </div>
              )}

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                <input type="password" className="w-full border border-gray-300 rounded-md px-4 py-2 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="粘贴 API Key" value={newKeyInput} onChange={(e) => setNewKeyInput(e.target.value)} />
                {apiProvider === 'newcoin' && <p className="text-xs text-indigo-500 mt-1">NewCoin 模式下请使用 NewCoin 提供的令牌 (sk-...)</p>}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                 <button onClick={() => setShowApiKeyModal(false)} className="text-gray-500 hover:text-gray-700 px-3 py-2 text-sm">取消</button>
                 <button onClick={handleSaveInitialKey} disabled={!newKeyInput.trim()} className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white px-4 py-2 rounded-md font-medium transition-colors">保存配置</button>
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 flex overflow-hidden">
            {/* Left Panel: Editor */}
            <div className={`flex-1 flex flex-col transition-all duration-500 ${inputMode === 'edit' ? 'translate-x-0' : '-translate-x-full hidden'}`}>
                <div className="flex-1 p-4 md:p-8 overflow-auto bg-gray-100 flex justify-center">
                    <div className="w-full max-w-3xl h-full flex flex-col">
                         <div className="bg-white rounded-t-lg border-b border-gray-200 px-4 py-2 flex justify-between items-center shadow-sm">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Markdown 编辑器</span>
                            <span className="text-xs text-gray-400">支持粘贴富文本 (Word/网页)</span>
                         </div>
                        <textarea
                            ref={textareaRef}
                            className="flex-1 w-full p-6 md:p-10 bg-white text-gray-800 text-lg leading-relaxed resize-none focus:outline-none shadow-sm rounded-b-lg font-serif"
                            placeholder="请在此粘贴您的小说或文章全文..."
                            value={markdownText}
                            onChange={(e) => setMarkdownText(e.target.value)}
                            onPaste={handlePaste}
                        />
                    </div>
                </div>
            </div>

            {/* Right Panel: Preview */}
            <div className={`flex-1 bg-gray-100 overflow-auto transition-all duration-500 flex flex-col items-center ${inputMode === 'preview' ? 'w-full' : 'hidden w-0'}`}>
               <div className="w-full max-w-3xl my-8">
                   <ArticlePreview 
                      fullText={markdownText || "# 预览模式\n\n请在左侧编辑器输入内容..."} 
                      scenes={[]} // No scenes in idle preview
                      onResultReady={() => {}}
                      onRegenerate={() => {}}
                   />
               </div>
            </div>
        </main>
      </div>
    );
  }

  // 2. Processing / Loading View
  if (processing.stage !== 'complete' && processing.stage !== 'idle') {
    return (
      <div className="h-screen w-full bg-gray-900 flex flex-col items-center justify-center relative overflow-hidden">
        {/* Background Elements */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 opacity-20">
            <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-purple-600 rounded-full mix-blend-multiply filter blur-xl animate-blob"></div>
            <div className="absolute top-1/3 right-1/4 w-64 h-64 bg-indigo-600 rounded-full mix-blend-multiply filter blur-xl animate-blob animation-delay-2000"></div>
            <div className="absolute bottom-1/4 left-1/3 w-64 h-64 bg-pink-600 rounded-full mix-blend-multiply filter blur-xl animate-blob animation-delay-4000"></div>
        </div>

        <div className="z-10 text-center px-4 flex flex-col items-center">
           <div className="mb-8 relative">
                <div className="w-64 md:w-80 aspect-square rounded-2xl overflow-hidden shadow-2xl border-4 border-indigo-500/30 relative bg-black">
                    <video 
                        key={loadingVideoSrc}
                        src={loadingVideoSrc || undefined}
                        autoPlay 
                        loop 
                        muted 
                        playsInline 
                        className="w-full h-full object-cover"
                        onError={(e) => {
                            console.error("Video load failed", e);
                            setIsVideoMissing(true);
                        }}
                    />
                     {/* Fallback Spinner if video missing */}
                    {(isVideoMissing || !loadingVideoSrc) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                             <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                        </div>
                    )}
                    
                    {/* Countdown Overlay */}
                    {cooldownTime > 0 && (
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center text-white z-20">
                            <div className="text-4xl font-bold mb-2 font-mono">{cooldownTime}s</div>
                            <div className="text-sm text-indigo-200">API 冷却中...</div>
                        </div>
                    )}
                </div>
           </div>
          
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">我知道你很急但是先别急</h2>
          <div className="h-1.5 w-64 bg-gray-700 rounded-full overflow-hidden mb-4">
             <div 
               className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500"
               style={{ width: `${processing.totalScenes > 0 ? (processing.completedScenes / processing.totalScenes) * 100 : 5}%` }}
             ></div>
          </div>
          <p className="text-indigo-200 text-lg animate-pulse">{processing.progressMessage}</p>
          <div className="mt-8 flex gap-4 text-sm text-gray-400">
             <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${processing.stage === 'analyzing' ? 'bg-yellow-400 animate-ping' : 'bg-gray-600'}`}></span>
                <span>剧情分析</span>
             </div>
             <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${processing.stage === 'generating' ? 'bg-green-400 animate-ping' : 'bg-gray-600'}`}></span>
                <span>视觉生成</span>
             </div>
             <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${processing.stage === 'complete' ? 'bg-blue-400' : 'bg-gray-600'}`}></span>
                <span>图文合成</span>
             </div>
          </div>
        </div>

        {/* Rate Limit Rescue Modal */}
        {showRateLimitModal && (
            <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
                <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-2xl">
                    <div className="text-center mb-4">
                        <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100 mb-4">
                            <svg className="h-6 w-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                        </div>
                        <h3 className="text-lg leading-6 font-medium text-gray-900">API 配额耗尽 (429)</h3>
                        <p className="text-sm text-gray-500 mt-2">
                            当前的 API Key 已达到速率限制。您可以输入一个新的 Key 来继续生成，程序将从中断的地方继续。
                        </p>
                    </div>
                    <div className="mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-1">新的 API Key</label>
                        <input 
                            type="password" 
                            className="w-full border border-gray-300 rounded-md px-4 py-2 focus:ring-2 focus:ring-indigo-500 outline-none"
                            placeholder="sk-..."
                            value={newKeyInput}
                            onChange={(e) => setNewKeyInput(e.target.value)}
                        />
                    </div>
                    <div className="mt-6 flex gap-3">
                        <button
                            onClick={() => setShowRateLimitModal(false)} // Just close to wait
                            className="flex-1 bg-gray-100 text-gray-700 px-4 py-2 rounded hover:bg-gray-200 transition-colors"
                        >
                            稍后重试
                        </button>
                        <button
                            onClick={handleResumeWithNewKey}
                            disabled={!newKeyInput.trim()}
                            className="flex-1 bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-400 transition-colors shadow-md"
                        >
                            更换并继续
                        </button>
                    </div>
                </div>
            </div>
        )}
      </div>
    );
  }

  // 3. Result View
  if (processing.stage === 'complete' && finalResult) {
      return (
          <div className="h-screen w-full bg-gray-100 flex flex-col">
               <header className="bg-white shadow-sm h-16 shrink-0 flex justify-between items-center px-6 z-20">
                    <div className="flex items-center gap-4">
                        <button onClick={() => setProcessing(prev => ({ ...prev, stage: 'idle' }))} className="text-gray-500 hover:text-indigo-600 flex items-center gap-1 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" /></svg>
                            <span>返回编辑</span>
                        </button>
                        <h2 className="text-lg font-bold text-gray-800">生成结果预览</h2>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={() => startProcessing(0)} className="text-gray-600 hover:text-indigo-600 px-3 py-2 text-sm font-medium transition-colors">
                            🔄 全部重新生成
                        </button>
                        <button onClick={downloadHtml} className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-md text-sm font-bold shadow-md flex items-center gap-2 transition-all transform hover:scale-105">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4-4m0 0l-4-4m4 4h12" /></svg>
                            下载 HTML
                        </button>
                    </div>
               </header>
               <div className="flex-1 overflow-auto p-4 md:p-8">
                   <ArticlePreview 
                        fullText={markdownText} 
                        scenes={scenes} 
                        onResultReady={setFinalResult}
                        onRegenerate={handleRegenerateScene}
                   />
               </div>
          </div>
      );
  }

  return null;
};

export default App;