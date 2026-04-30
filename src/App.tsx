import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  setDoc, 
  getDoc,
  doc, 
  deleteDoc, 
  orderBy 
} from 'firebase/firestore';
import { db, handleFirestoreError } from './lib/firebase';
import { Recipe, OperationType } from './types';
import { extractRecipeFromTranscript, queryRecipes, getLlmProviderLabel } from './services/llm';
import { 
  Plus, 
  Search, 
  Trash2, 
  Youtube, 
  Sparkles, 
  IceCream, 
  Loader2,
  ChevronRight,
  ChefHat,
  Grid,
  Library,
  FileText,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const LOCAL_USER_ID = 'local-user';
function isFirestoreOfflineError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('client is offline') || msg.includes('failed to get document');
}

export default function App() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [isFirestoreOnline, setIsFirestoreOnline] = useState(true);
  const [view, setView] = useState<'dashboard' | 'vault'>('dashboard');
  const [url, setUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [batchStatus, setBatchStatus] = useState<{ current: number, total: number, skipped: number, errors: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [chatAnswer, setChatAnswer] = useState<string | null>(null);
  const [isChatting, setIsChatting] = useState(false);
  const [vaultSearch, setVaultSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addLog = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 8));
  };

  const stopProcessing = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsProcessing(false);
      setError("Procesamiento cancelado.");
      addLog("[SYSTEM] Process aborted by user");
    }
  };

  const filteredRecipes = recipes.filter(r => 
    r.title.toLowerCase().includes(vaultSearch.toLowerCase()) || 
    r.ingredients.some(ing => ing.toLowerCase().includes(vaultSearch.toLowerCase())) ||
    r.category.toLowerCase().includes(vaultSearch.toLowerCase())
  );

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const controller = new AbortController();
    setAbortController(controller);
    setIsProcessing(true);
    setError(null);
    addLog(`[FILE] Loading ${file.name}...`);
    
    try {
      const text = await file.text();
      const urls = text.split(/\r?\n/).map(u => u.trim()).filter(u => u.startsWith('http'));
      
      if (urls.length === 0) {
        throw new Error("No se encontraron URLs válidas en el archivo.");
      }

      setBatchStatus({ current: 0, total: urls.length, skipped: 0, errors: 0 });
      let skippedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < urls.length; i++) {
        if (controller.signal.aborted) break;

        const line = urls[i];
        try {
          const isChannel = line.includes('/@') || line.includes('/channel/') || line.includes('/c/') || line.includes('/user/');
          
          if (isChannel) {
            addLog(`[DISCOVERY] Scanning channel: ${line.split('@')[1] || 'URL'}`);
            const res = await fetch('/api/channel-videos', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channelUrl: line }),
              signal: controller.signal
            });
            const { videoIds, error: channelError } = await res.json();
            if (channelError) throw new Error(channelError);

            if (videoIds) {
              for (const vId of videoIds) {
                if (controller.signal.aborted) break;
                const result = await processSingleVideo(vId);
                if (result === 'skipped') skippedCount++;
                else if (result === 'error') errorCount++;
                else addLog(`[INGEST] Success: ${vId}`);
              }
            }
          } else {
            // Robust video ID extraction
            let vId = null;
            const videoIdMatch = line.match(/(?:v=|\/|be\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/i);
            if (videoIdMatch) {
              vId = videoIdMatch[1];
            } else if (line.match(/^[a-zA-Z0-9_-]{11}$/)) {
              // Raw 11-char ID
              vId = line;
            }

            if (vId) {
              const result = await processSingleVideo(vId);
              if (result === 'skipped') { skippedCount++; addLog(`[SKIP] Duplicate: ${vId}`); }
              else if (result === 'error') { errorCount++; addLog(`[FAIL] No metadata: ${vId}`); }
              else addLog(`[INGEST] Success: ${vId}`);
            } else {
              addLog(`[WARN] Invalid URL/ID skip: ${line.substring(0, 20)}`);
            }
          }
        } catch (innerErr: any) {
          console.warn("Item failed:", innerErr);
          errorCount++;
          addLog(`[ERROR] Item fail: ${innerErr.message || 'Unknown'}`);
        }

        setBatchStatus({ current: i + 1, total: urls.length, skipped: skippedCount, errors: errorCount });
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      addLog("[BATCH] Processing complete");
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || "Error al procesar el archivo");
        addLog(`[FATAL] ${err.message}`);
      }
    } finally {
      setIsProcessing(false);
      setAbortController(null);
      setTimeout(() => setBatchStatus(null), 10000);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  useEffect(() => {
    const q = query(
      collection(db, 'recipes'), 
      where('userId', '==', LOCAL_USER_ID),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Recipe));
      setRecipes(data);
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'recipes');
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let isMounted = true;

    const checkFirestore = async () => {
      try {
        await getDoc(doc(db, 'users', LOCAL_USER_ID));
        if (isMounted) setIsFirestoreOnline(true);
      } catch (err) {
        if (isMounted) setIsFirestoreOnline(!isFirestoreOfflineError(err));
      }
    };

    void checkFirestore();
    const interval = setInterval(() => void checkFirestore(), 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const processSingleVideo = async (videoId: string) => {
    try {
      addLog(`[GET] Checking cache: ${videoId}`);
      // Duplicate check (personal vault)
      try {
        const sourceDoc = await getDoc(doc(db, 'users', LOCAL_USER_ID, 'video_sources', videoId));
        if (sourceDoc.exists()) {
          addLog(`[SKIP] Already processed: ${videoId}`);
          return 'skipped';
        }
      } catch (cacheErr) {
        if (isFirestoreOfflineError(cacheErr)) {
          addLog('[WARN] Firestore offline, skipping cache check');
        } else {
          throw cacheErr;
        }
      }

      // Fetch transcript via backend
      const res = await fetch('/api/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId })
      });
      
      if (!res.ok) {
        const text = await res.text();
        addLog(`[SERVER] HTTP ${res.status}: ${text.substring(0, 30)}`);
        return 'error';
      }

      const { transcript, error: serverError, details } = await res.json();
      if (serverError) {
        addLog(`[SERVER] ${serverError.substring(0, 30)}${details ? ' | ' + details.substring(0, 30) : ''}`);
        return 'error';
      }

      if (!transcript || transcript.length < 5) {
        addLog(`[ERROR] Content too thin for ${videoId}`);
        return 'error';
      }

      addLog(`[AI] Processing payload...`);
      // AI Extraction
      const extracted = await extractRecipeFromTranscript(transcript, videoId);
      
      addLog(`[SAVE] Writing to vault: ${extracted.title || videoId}`);
      // Idempotent write by videoId to avoid duplicates.
      const recipeDocId = `${LOCAL_USER_ID}_${videoId}`;
      await setDoc(doc(db, 'recipes', recipeDocId), {
        ...extracted,
        id: recipeDocId,
        userId: LOCAL_USER_ID,
        youtubeId: videoId,
        createdAt: new Date().toISOString()
      }, { merge: true });

      await setDoc(doc(db, 'users', LOCAL_USER_ID, 'video_sources', videoId), {
        youtubeId: videoId,
        status: 'completed',
        userId: LOCAL_USER_ID,
        updatedAt: new Date().toISOString()
      });
      return 'processed';
    } catch (err: any) {
      console.warn(`Failed to process video ${videoId}:`, err);
      addLog(`[CATCH] ${err.message || 'Unknown error'}`);
      return 'error';
    }
  };

  const processVideo = async () => {
    if (!url) return;
    if (!isFirestoreOnline) {
      setError('Firestore parece offline. Verifica conexión/proyecto y vuelve a intentar.');
      addLog('[OFFLINE] Firestore unavailable');
      return;
    }
    
    const controller = new AbortController();
    setAbortController(controller);
    setIsProcessing(true);
    setError(null);
    addLog(`[INPUT] Validating target: ${url.length > 30 ? url.substring(0, 30) + '...' : url}`);
    
    try {
      const trimmedUrl = url.trim();
      const isChannel = trimmedUrl.includes('/@') || trimmedUrl.includes('/channel/') || trimmedUrl.includes('/c/') || trimmedUrl.includes('/user/');
      
      if (isChannel) {
        addLog("[QUERY] Searching channel content...");
        const res = await fetch('/api/channel-videos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelUrl: trimmedUrl }),
          signal: controller.signal
        });
        const { videoIds, error: channelError } = await res.json();
        if (channelError) throw new Error(channelError);

        let skippedCount = 0;
        let errorCount = 0;
        setBatchStatus({ current: 0, total: videoIds.length, skipped: 0, errors: 0 });
        addLog(`[QUEUE] Found ${videoIds.length} candidate videos`);
        
        for (let i = 0; i < videoIds.length; i++) {
          if (controller.signal.aborted) break;
          
          const result = await processSingleVideo(videoIds[i]);
          if (result === 'skipped') { skippedCount++; addLog(`[SKIP] Excluded: ${videoIds[i]}`); }
          else if (result === 'error') { errorCount++; addLog(`[FAIL] Meta extraction err: ${videoIds[i]}`); }
          else addLog(`[INGEST] Success: ${videoIds[i]}`);

          setBatchStatus({ 
            current: i + 1, 
            total: videoIds.length, 
            skipped: skippedCount,
            errors: errorCount
          });
          await new Promise(resolve => setTimeout(resolve, i % 5 === 0 ? 800 : 200));
        }
      } else {
        let videoId = null;
        const videoIdMatch = trimmedUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([^&?]{11})/i);
        
        if (videoIdMatch) {
          videoId = videoIdMatch[1];
        } else if (trimmedUrl.match(/^[a-zA-Z0-9_-]{11}$/)) {
          videoId = trimmedUrl;
        }

        if (!videoId) {
          throw new Error("URL de YouTube no válida.");
        }

        addLog(`[PROCESS] Target ID detected: ${videoId}`);
        const result = await processSingleVideo(videoId);
        if (result === 'skipped') {
          setError("Este video ya está en tu colección.");
          addLog(`[SKIP] Video ${videoId} exists`);
        } else if (result === 'error') {
          setError("No se pudo obtener el contenido del video.");
          addLog(`[FAIL] Extraction error for ${videoId}`);
        } else {
          addLog(`[DONE] Indexed ${videoId}`);
        }
      }

      setUrl('');
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || "Error al procesar");
        addLog(`[FATAL] ${err.message}`);
      }
    } finally {
      setIsProcessing(false);
      setAbortController(null);
      setTimeout(() => setBatchStatus(null), 10000);
    }
  };

  const handleAskAI = async () => {
    if (!searchQuery) return;
    setIsChatting(true);
    try {
      const answer = await queryRecipes(searchQuery, recipes);
      setChatAnswer(answer);
    } catch (err) {
      console.error(err);
    } finally {
      setIsChatting(false);
    }
  };

  const deleteRecipe = async (id: string, vidId: string) => {
    try {
      await deleteDoc(doc(db, 'recipes', id));
      await deleteDoc(doc(db, 'users', LOCAL_USER_ID, 'video_sources', vidId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `recipes/${id}`);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-4 sm:p-6 overflow-x-hidden flex flex-col max-w-[1400px] mx-auto">
      {/* Header Section */}
      <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6 mb-10">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <span className="bg-accent p-1.5 rounded-lg text-zinc-950">
              <IceCream size={24} />
            </span>
            Creami <span className="text-zinc-500">Knowledge Engine</span>
          </h1>
          <p className="text-[10px] text-zinc-500 mt-1 uppercase tracking-widest font-mono">Retrieval Augmented Ice Cream Generation</p>
        </div>

        <div className="flex items-center gap-2 bg-zinc-900/50 p-1 rounded-xl border border-zinc-800">
          <button 
            onClick={() => setView('dashboard')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all",
              view === 'dashboard' ? "bg-zinc-800 text-white shadow-lg" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Grid size={14} /> Dashboard
          </button>
          <button 
            onClick={() => setView('vault')}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all",
              view === 'vault' ? "bg-zinc-800 text-white shadow-lg" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <Library size={14} /> My Vault
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-full">
          <div className={cn("w-2 h-2 rounded-full", isFirestoreOnline ? "bg-green-500 animate-pulse" : "bg-red-500")} />
          <span className="text-[10px] font-bold uppercase tracking-wider">
            {isFirestoreOnline ? 'Firestore online' : 'Firestore offline'}
          </span>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {view === 'dashboard' ? (
          <motion.div 
            key="dashboard"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="grid grid-cols-12 grid-rows-6 gap-4 flex-grow min-h-[800px]"
          >
            {/* Query Interface (Large Box) - AI Advisor */}
            <div className="col-span-12 lg:col-span-8 row-span-4 bg-zinc-900 border border-zinc-800 rounded-3xl p-8 flex flex-col shadow-2xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none group-hover:opacity-[0.05] transition-opacity">
                <Sparkles size={160} />
              </div>

              <div className="flex items-center justify-between mb-8 border-b border-zinc-800 pb-6">
                <div className="flex items-center gap-2">
                  <span className="text-accent"><Sparkles size={20} /></span>
                  <h2 className="text-xs font-bold uppercase tracking-widest">Asistente Chef {getLlmProviderLabel()}</h2>
                </div>
                <span className="text-[10px] text-zinc-500 bg-zinc-950 px-3 py-1 rounded-full border border-zinc-800 font-mono">
                  RAG CONTEXT: {recipes.length} ITEMS
                </span>
              </div>

              <div className="flex-grow flex flex-col justify-end space-y-6">
                <AnimatePresence mode="wait">
                  {chatAnswer ? (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-accent/5 p-6 rounded-2xl border border-accent/20"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <p className="text-[9px] font-black text-accent uppercase tracking-widest">Knowledge Extraction</p>
                        <button onClick={() => setChatAnswer(null)} className="text-zinc-600 hover:text-zinc-400">
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <div className="text-sm leading-relaxed text-zinc-300">
                        {chatAnswer}
                      </div>
                    </motion.div>
                  ) : (
                    <div className="bg-zinc-800/20 p-8 rounded-2xl border border-dashed border-zinc-800 flex flex-col items-center justify-center text-center space-y-3">
                      <ChefHat className="text-zinc-700" size={32} />
                      <p className="text-zinc-500 text-sm italic">Escribe una pregunta para consultar tu base de datos de recetas...</p>
                    </div>
                  )}
                </AnimatePresence>
              </div>

              <div className="mt-8 bg-zinc-950 border border-zinc-800 rounded-2xl p-2.5 flex items-center justify-between group-within:ring-2 ring-accent/20 transition-all">
                <input 
                  type="text"
                  placeholder="Ask about vanilla bases, stabilizers, or specific recipes..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAskAI()}
                  className="bg-transparent border-none outline-none flex-grow px-4 text-sm font-medium placeholder:text-zinc-600"
                />
                <button 
                  onClick={handleAskAI}
                  disabled={isChatting || !searchQuery}
                  className="bg-accent text-zinc-950 p-3 rounded-xl disabled:opacity-30 hover:scale-105 transition-all shadow-[0_0_15px_rgba(249,115,22,0.3)]"
                >
                  {isChatting ? <Loader2 className="animate-spin" size={20} /> : <Search size={20} />}
                </button>
              </div>
            </div>

            {/* Extraction Pipeline - Importer */}
            <div className="col-span-12 lg:col-span-4 row-span-2 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col justify-center">
              <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-6 flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse"></span> Pipeline de Ingestión
              </h3>
              <div className="space-y-5">
                <div className="flex flex-col gap-3">
                  <div className="relative flex gap-2">
                    <input 
                      type="text"
                      placeholder="URL del canal o video..."
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      className="flex-grow bg-zinc-950 border border-zinc-800 rounded-xl py-3.5 pl-4 pr-3 text-sm outline-none focus:border-accent/40 font-medium"
                    />
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isProcessing}
                      className="bg-zinc-800 hover:bg-zinc-700 text-zinc-400 p-3 rounded-xl transition-all flex items-center justify-center min-w-[50px] border border-zinc-700 disabled:opacity-20"
                      title="Cargar TXT de URLs"
                    >
                      <FileText size={20} />
                    </button>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleFileUpload} 
                      accept=".txt" 
                      className="hidden" 
                    />
                    <button 
                      onClick={processVideo}
                      disabled={isProcessing || !url}
                      className="absolute right-[60px] top-1/2 -translate-y-1/2 p-2 text-accent disabled:opacity-20 transition-transform active:scale-90"
                    >
                      {isProcessing ? <Loader2 className="animate-spin" size={20} /> : <Plus size={20} />}
                    </button>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter">
                      <span className="text-zinc-500">
                        {batchStatus 
                          ? `Proc: ${batchStatus.current}/${batchStatus.total} | Skip: ${batchStatus.skipped} | Err: ${batchStatus.errors}` 
                          : "Status Ingestión"}
                      </span>
                      <span className={cn(isProcessing ? "text-accent" : "text-zinc-700")}>
                        {isProcessing ? "Active" : "Standby"}
                      </span>
                    </div>
                    <div className="w-full bg-zinc-950 border border-zinc-800 h-1.5 rounded-full overflow-hidden flex">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ 
                          width: batchStatus 
                            ? `${(batchStatus.current / batchStatus.total) * 100}%` 
                            : isProcessing ? '85%' : '0%' 
                        }}
                        className={cn(
                          "h-full transition-all duration-500 rounded-full",
                          isProcessing ? "bg-accent shadow-[0_0_10px_rgba(249,115,22,0.5)]" : "bg-zinc-800"
                        )}
                      />
                    </div>
                    {isProcessing && (
                      <button 
                        onClick={stopProcessing}
                        className="w-full mt-2 py-1.5 bg-red-500/10 border border-red-500/20 text-red-500 text-[9px] font-bold uppercase rounded-lg hover:bg-red-500/20 transition-all"
                      >
                        Abort Processing
                      </button>
                    )}
                  </div>
                </div>
              </div>
              
              {error && (
                <p className="mt-4 text-[10px] text-red-400 font-mono italic bg-red-500/5 p-2 rounded-lg border border-red-500/10">
                  !! ERROR: {error}
                </p>
              )}
            </div>

            {/* Vector DB Status - Stats */}
            <div className="col-span-12 lg:col-span-4 row-span-2 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col">
              <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-4">Base de Conocimiento</h3>
              <div className="flex items-end gap-3 flex-grow">
                <div className="flex-grow">
                  <p className="text-4xl font-mono font-bold tracking-tighter">{recipes.length * 12}</p>
                  <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-tight">Vectores Indexados</p>
                </div>
                <div className="w-24 h-16 flex items-end gap-1.5">
                  {[0.2, 0.45, 0.3, 0.9, 0.6, 0.8].map((h, i) => (
                    <div 
                      key={i} 
                      style={{ height: `${h * 100}%` }} 
                      className={cn("w-full transition-all", i === 3 ? "bg-accent shadow-[0_0_10px_rgba(249,115,22,0.3)]" : "bg-zinc-800")}
                    />
                  ))}
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-zinc-800 flex justify-between items-center text-[9px] font-mono text-zinc-600 uppercase">
                <span>Model: gemini-3-flash</span>
                <span>v_index_creami_01</span>
              </div>
            </div>

            {/* Recent Sources - Recipes List */}
            <div className="col-span-12 lg:col-span-4 row-span-2 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col overflow-hidden">
              <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-5">Ingestión Reciente</h3>
              <div className="space-y-3 overflow-y-auto pr-2 custom-scrollbar flex-grow">
                {recipes.slice(0, 5).map((recipe, i) => (
                  <div key={recipe.id} className="flex items-center gap-3 group">
                    <div className="w-8 h-8 rounded-lg bg-zinc-950 border border-zinc-800 flex-shrink-0 flex items-center justify-center font-mono text-[10px] font-bold text-zinc-500 group-hover:text-accent group-hover:border-accent/40 transition-colors">
                      {(i + 1).toString().padStart(2, '0')}
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-xs font-bold truncate text-zinc-300 group-hover:text-white transition-colors">{recipe.title}</p>
                      <p className="text-[10px] text-zinc-600 font-mono tracking-tighter uppercase">{recipe.category}</p>
                    </div>
                  </div>
                ))}
                {recipes.length === 0 && (
                  <div className="h-full flex items-center justify-center opacity-20 italic text-xs">Waiting for ingestion...</div>
                )}
              </div>
            </div>

            {/* Processing Logs */}
            <div className="col-span-12 lg:col-span-4 row-span-2 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 font-mono text-[10px] flex flex-col">
              <h3 className="text-[10px] font-sans font-black uppercase tracking-[0.2em] text-zinc-500 mb-4 text-center border-b border-zinc-800 pb-2">Propulsion Logs</h3>
              <div className="space-y-1.5 overflow-hidden text-[9px] text-zinc-500">
                {logs.length > 0 ? (
                  logs.map((log, i) => (
                    <p key={i} className={cn(
                      i === 0 ? "text-zinc-300" : "opacity-60",
                      log.includes('[ERROR]') || log.includes('[FAIL]') ? "text-red-400" : 
                      log.includes('[INGEST]') ? "text-green-400" : 
                      log.includes('[DISCOVERY]') ? "text-accent" : ""
                    )}>
                      {log}
                    </p>
                  ))
                ) : (
                  <>
                    <p className="text-green-500">[STATUS] Real-time indexing operational</p>
                    <p>[INFO] Firebase firestore :: data_pull ({recipes.length})</p>
                    <p>[DEBUG] Processing chunk hash: {Math.random().toString(36).substring(7)}</p>
                    {isProcessing && <p className="text-yellow-500 animate-pulse">[WARN] Active extraction pipeline in progress...</p>}
                    <p className={cn(chatAnswer ? "text-orange-400" : "")}>[INFO] {getLlmProviderLabel()} semantic resolve: {chatAnswer ? "SUCCESS" : "IDLE"}</p>
                    <p>[DEBUG] Context window optimized (12.4k tokens)</p>
                  </>
                )}
              </div>
            </div>

            {/* Tech Specs - Architecture Box */}
            <div className="col-span-12 lg:col-span-4 row-span-2 bg-accent text-zinc-950 rounded-3xl p-6 flex flex-col justify-between shadow-[0_0_40px_rgba(249,115,22,0.1)]">
              <div>
                <h3 className="text-[10px] font-black uppercase tracking-[0.2em] mb-1 opacity-70">Architecture Specs</h3>
                <p className="text-sm leading-tight font-black uppercase tracking-tighter">Modular Retrieval Augmented Generation (RAG)</p>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4">
                <div>
                  <p className="text-[8px] font-black uppercase opacity-60">Engine</p>
                  <p className="text-[10px] font-bold font-mono">{getLlmProviderLabel()}</p>
                </div>
                <div>
                  <p className="text-[8px] font-black uppercase opacity-60">Store</p>
                  <p className="text-[10px] font-bold font-mono">Cloud Firestore</p>
                </div>
                <div>
                  <p className="text-[8px] font-black uppercase opacity-60">Orchestrator</p>
                  <p className="text-[10px] font-bold font-mono">React v19.0</p>
                </div>
                <div>
                  <p className="text-[8px] font-black uppercase opacity-60">Status</p>
                  <p className="text-[10px] font-bold font-mono">Production_Stable</p>
                </div>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div 
            key="vault"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.02 }}
            className="flex-grow flex flex-col"
          >
            <div className="flex justify-between items-center mb-8 bg-zinc-900 p-6 rounded-3xl border border-zinc-800">
              <div>
                <h2 className="text-2xl font-bold">Recipe Vault</h2>
                <p className="text-zinc-500 text-xs font-mono uppercase tracking-widest">{recipes.length} ITEMS TOTAL</p>
              </div>
              <div className="relative w-full max-w-md">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
                <input 
                  type="text"
                  placeholder="Search ingredients, titles, categories..."
                  value={vaultSearch}
                  onChange={(e) => setVaultSearch(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl py-3 pl-12 pr-4 text-sm outline-none focus:border-accent/40 transition-all font-medium"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {filteredRecipes.map((recipe) => (
                <div 
                  key={recipe.id}
                  className="bg-zinc-900 border border-zinc-800 rounded-[2rem] p-6 hover:shadow-2xl hover:border-accent/20 transition-all group relative overflow-hidden"
                >
                  <div className="flex justify-between items-start mb-6">
                    <span className="text-[9px] font-black uppercase tracking-[0.2em] text-accent/80 bg-accent/10 px-3 py-1 rounded-full border border-accent/20">
                      {recipe.category}
                    </span>
                    <button 
                      onClick={() => deleteRecipe(recipe.id, recipe.youtubeId)}
                      className="opacity-0 group-hover:opacity-100 p-2 text-zinc-600 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  <h3 className="font-bold text-lg mb-4 text-zinc-100 group-hover:text-white transition-colors">{recipe.title}</h3>
                  
                  <div className="space-y-4 mb-6">
                    <div className="space-y-2">
                      <p className="text-[9px] font-black text-zinc-600 uppercase tracking-widest flex items-center gap-2">
                        <span className="w-4 h-[1px] bg-zinc-800" /> Elements
                      </p>
                      <ul className="text-[11px] text-zinc-400 space-y-1">
                        {recipe.ingredients.slice(0, 3).map((ing, i) => (
                          <li key={i} className="flex items-center gap-2 truncate">
                            <div className="w-1 h-1 bg-accent/40 rounded-full" />
                            {ing}
                          </li>
                        ))}
                        {recipe.ingredients.length > 3 && (
                          <li className="text-[9px] italic text-zinc-600 mt-1">
                            +{recipe.ingredients.length - 3} more...
                          </li>
                        )}
                      </ul>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-6 border-t border-zinc-800 mt-auto">
                    <a 
                      href={`https://youtube.com/watch?v=${recipe.youtubeId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-bold text-zinc-500 flex items-center gap-2 hover:text-accent transition-colors"
                    >
                      <Youtube size={14} className="text-red-500" />
                      SOURCE_LINK
                    </a>
                    <button className="w-8 h-8 rounded-full bg-zinc-950 flex items-center justify-center text-zinc-500 group-hover:bg-accent group-hover:text-zinc-950 transition-all shadow-lg active:scale-90">
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
