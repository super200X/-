export interface GeneratedScene {
  id: number;
  quote: string; // The text anchor from the article
  visualPrompt: string; // The generated prompt for the image model
  reasoning: string; // Why this scene was chosen
  contextDescription?: string; // Narrative context for better prompt generation
  imageUrl?: string;
  status: 'pending' | 'generating' | 'completed' | 'error';
}

export interface ProcessingState {
  stage: 'idle' | 'analyzing' | 'generating' | 'complete' | 'error';
  progressMessage: string;
  totalScenes: number;
  completedScenes: number;
}

export interface RenderedResult {
  markdownWithImages: string; // The final markdown text with image tags injected
  htmlContent: string; // The rendered HTML for the UI (includes buttons)
  cleanHtmlContent: string; // The rendered HTML for export (clean images only)
}

export interface ArticlePreviewProps {
  fullText: string;
  scenes: GeneratedScene[];
  onResultReady: (result: RenderedResult) => void;
  onRegenerate: (sceneId: number) => void;
}