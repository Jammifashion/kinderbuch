/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { GoogleGenAI } from '@google/genai';
import { db, auth, storage } from './lib/firebase';
import { collection, addDoc, serverTimestamp, getDocs, updateDoc, doc, deleteDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';

// --- Initialization ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL_NAME = 'gemini-3.1-flash-lite';
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const ADMIN_EMAIL = 'gbr@jammifashion.de'; 

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface StoryResult {
  id: string; // Add ID field
  titel_optionen: string[];
  ausgewaehlter_titel?: string;
  cost_metrics?: {
    text_input_tokens: number;
    text_output_tokens: number;
    images_generated: number;
    total_cost_usd: number;
  };
  zielgruppe: string;
  storyline: {
    anfang: string;
    mitte: string;
    ende: string;
  };
  story_skelett: {
    kapitel_1: string;
    kapitel_2: string;
    kapitel_3: string;
    kapitel_4: string;
    kapitel_5: string;
  };
  hauptcharakter: {
    name: string;
    gattung: string;
    persoenlichkeit: string;
    aussehen_de: string;
    bild_prompt_en: string;
    avatar_url?: string;
  };
}

const AdminDashboard = ({ allBooks }: { allBooks: StoryResult[] }) => {
  const [liveSpend, setLiveSpend] = useState<number | null>(null);
  const [isLiveLoading, setIsLiveLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const handleFetchLiveBilling = async () => {
    setIsLiveLoading(true);
    setDashboardError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        throw new Error("Nicht authentifiziert. Bitte regulär mit Google anmelden.");
      }
      const response = await fetch('/api/admin/live-billing', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Abfrage fehlgeschlagen");
      }

      const data = await response.json();
      if (data.currentSpend !== undefined) {
        setLiveSpend(data.currentSpend);
      }
    } catch (err: any) {
      console.error("Live billing error:", err);
      setDashboardError(err.message || "Unbekannter Fehler bei der Abfrage.");
    } finally {
      setIsLiveLoading(false);
    }
  };

  const stats = useMemo(() => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    let total = 0;
    let last30Days = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    allBooks.forEach(book => {
      if (!book.cost_metrics) return;
      total += book.cost_metrics.total_cost_usd;
      totalInputTokens += book.cost_metrics.text_input_tokens;
      totalOutputTokens += book.cost_metrics.text_output_tokens;
      
      // @ts-ignore
      const createdAt = book.created_at?.toDate ? book.created_at.toDate() : (book.created_at ? new Date(book.created_at) : null);
      if (createdAt && createdAt >= thirtyDaysAgo) {
        last30Days += book.cost_metrics.total_cost_usd;
      }
    });
    return { total, last30Days, totalInputTokens, totalOutputTokens };
  }, [allBooks]);

  return (
    <div className="space-y-4 mb-8">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-3xl bg-white p-6 border border-orange-100 shadow-sm transition-all hover:border-orange-200">
          <h3 className="text-sm font-bold text-orange-500 uppercase tracking-widest mb-1">💰 Gesamtausgaben</h3>
          <p className="text-3xl font-bold text-slate-800">${stats.total.toFixed(2)}</p>
        </div>
        <div className="rounded-3xl bg-white p-6 border border-slate-100 shadow-sm">
          <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">📅 Letzte 30 Tage</h3>
          <p className="text-3xl font-bold text-slate-800">${stats.last30Days.toFixed(2)}</p>
        </div>
        <div className="rounded-3xl bg-white p-6 border border-slate-100 shadow-sm">
          <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">📥 Input Tokens</h3>
          <p className="text-3xl font-bold text-slate-800">{stats.totalInputTokens.toLocaleString()}</p>
        </div>
        <div className="rounded-3xl bg-white p-6 border border-slate-100 shadow-sm">
          <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">📤 Output Tokens</h3>
          <p className="text-3xl font-bold text-slate-800">{stats.totalOutputTokens.toLocaleString()}</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-4 p-4 bg-white rounded-3xl border border-slate-100 shadow-sm animate-in fade-in duration-500">
        <button 
          onClick={handleFetchLiveBilling}
          disabled={isLiveLoading}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-slate-800 text-white font-bold rounded-full transition-all active:scale-95 disabled:bg-slate-300 shadow-[0_4px_0_rgb(30,41,59)] active:translate-y-1 active:shadow-none h-12 min-w-[260px] cursor-pointer"
        >
          {isLiveLoading ? (
            <span className="animate-spin text-xl">🔄</span>
          ) : "🔄 Live-Cloud-Konto abfragen"}
        </button>
        
        {liveSpend !== null && !dashboardError && (
          <div className="animate-in fade-in slide-in-from-left-4 duration-500">
            <p className="text-lg font-bold text-slate-800">
              Live-Verbrauch laut Google: <span className="text-orange-600">${liveSpend.toFixed(2)}</span>
            </p>
            <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-tighter leading-tight">
              Hinweis: Google aktualisiert diese API-Werte mit einer systembedingten Verzögerung von 1-3 Stunden.
            </p>
          </div>
        )}

        {dashboardError && (
          <p className="text-sm font-medium text-red-500 animate-in shake">
            ❌ {dashboardError}
          </p>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [allBooks, setAllBooks] = useState<StoryResult[]>([]);
  const [activeTab, setActiveTab] = useState<'create' | 'library'>('create');
  const [isDevMode, setIsDevMode] = useState(false);
  const [idea, setIdea] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [result, setResult] = useState<StoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<StoryResult | null>(null);
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | 'selected' | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (authUser) => {
      setUser(authUser);
      if (authUser?.email === ADMIN_EMAIL) {
        fetchBooks();
      }
    });
  }, []);

  const fetchBooks = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'buecher'));
      const books = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StoryResult));
      setAllBooks(books);
    } catch (err) {
      console.error("Error fetching books:", err);
    }
  };

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      setError('Login fehlgeschlagen. Bitte versuche es noch einmal.');
    }
  };

  const handleDevLogin = () => {
    setIsDevMode(true);
  };

  const currentUser = isDevMode ? { email: ADMIN_EMAIL, uid: 'dev-user' } : user;

  if (!currentUser) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-[#FFFDF2] gap-4">
        <button onClick={handleLogin} className="rounded-3xl bg-orange-500 px-8 py-5 text-xl font-bold text-white shadow-[0_8px_0_rgb(194,65,12)]">
          Mit Google anmelden
        </button>
        <p className="text-xs text-stone-500 text-center max-w-sm mt-4">
          Hinweis: Wenn das Login-Fenster nicht erscheint, öffne die Vorschau bitte in einem neuen Tab (oben rechts auf das Symbol klicken).
        </p>
      </div>
    );
  }

  if (currentUser.email !== ADMIN_EMAIL) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#FFFDF2] p-6 text-center">
        <div className="rounded-[40px] bg-white p-10 shadow-xl">
          <h1 className="text-3xl font-bold text-orange-600">Zutritt verweigert</h1>
          <p className="mt-4 text-slate-500">Du hast leider keine Berechtigung für diese App.</p>
          <button onClick={() => { signOut(auth); setIsDevMode(false); }} className="mt-6 rounded-full bg-slate-200 px-6 py-2">Ausloggen</button>
        </div>
      </div>
    );
  }

  // --- Handlers ---
  const handleGenerate = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const prompt = `Erstelle basierend auf der Idee: "${idea}" ein Kinderbuch-Konzept. Die Antwort MUSS zwingend ein valides JSON-Objekt sein, das exakt dieser Struktur entspricht (kein Markdown drumherum, keine zusätzlichen Zeichen):
      {
        "titel_optionen": ["...", "...", "..."],
        "zielgruppe": "...",
        "storyline": { "anfang": "...", "mitte": "...", "ende": "..." },
        "story_skelett": { "kapitel_1": "...", "kapitel_2": "...", "kapitel_3": "...", "kapitel_4": "...", "kapitel_5": "..." },
        "hauptcharakter": { "name": "...", "gattung": "...", "persoenlichkeit": "...", "aussehen_de": "...", "bild_prompt_en": "..." }
      }`;
      
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
      });
      // Track cost
      await fetch('/api/track-cost', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          bookId: 'dummy-id', // Needs to be real ID in a real app, but this is a simplified example
          usage: {
            promptTokens: response.usageMetadata?.promptTokenCount,
            outputTokens: response.usageMetadata?.candidatesTokenCount
          }
        })
      });
      const text = response.text || '';
      const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
      const storyData: StoryResult = JSON.parse(cleanJson);

      // Save to Firestore
      try {
        const docRef = await addDoc(collection(db, 'buecher'), {
          ...storyData,
          original_idea: idea,
          created_at: serverTimestamp(),
          status: 'draft'
        });
        const bookId = docRef.id;
        setResult({ 
          ...storyData, 
          id: bookId,
          cost_metrics: {
            text_input_tokens: 0,
            text_output_tokens: 0,
            images_generated: 0,
            total_cost_usd: 0
          }
        });
        
        await fetch('/api/track-cost', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            bookId,
            usage: {
              promptTokens: response.usageMetadata?.promptTokenCount,
              outputTokens: response.usageMetadata?.candidatesTokenCount
            }
          })
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, 'buecher');
      }

    } catch (err: any) {
      console.error('Error generating story:', err);
      try {
        const errInfo = JSON.parse(err.message);
        setError(`Fehler beim Speichern: ${errInfo.error}`);
      } catch {
        setError('Hoppla! Da ist etwas schiefgelaufen beim Geschichten-Zaubern. Bitte versuche es noch einmal.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadBackup = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'buecher'));
      const data = querySnapshot.docs.map(doc => doc.data());
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup_${new Date().toISOString()}.json`;
      a.click();
    } catch (err) {
      setError('Backup konnte nicht erstellt werden.');
    }
  };

  const performDeleteBook = async (bookId: string) => {
    try {
      // Delete from Firestore
      await deleteDoc(doc(db, 'buecher', bookId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `buecher/${bookId}`);
    }
  };

  const handleUpdateBook = async (updatedBook: StoryResult) => {
    try {
      await updateDoc(doc(db, 'buecher', updatedBook.id), { ...updatedBook });
      setAllBooks(prev => prev.map(b => b.id === updatedBook.id ? updatedBook : b));
      if (result && result.id === updatedBook.id) {
        setResult(updatedBook);
      }
      setEditingBook(null);
    } catch (err: any) {
      console.error("Update error:", err);
      setError(`Speichern fehlgeschlagen: ${err.message || 'Unbekannter Fehler'}`);
    }
  };
  
  const handleToggleSelectBook = (bookId: string) => {
    const newSelected = new Set(selectedBooks);
    if (newSelected.has(bookId)) newSelected.delete(bookId);
    else newSelected.add(bookId);
    setSelectedBooks(newSelected);
  };

  const handleDeleteBook = (bookId: string) => {
    setShowDeleteConfirm(bookId);
  };

  const handleDeleteSelected = () => {
    setShowDeleteConfirm('selected');
  };

  const confirmDelete = async () => {
    if (!showDeleteConfirm) return;
    
    if (showDeleteConfirm === 'selected') {
      try {
        for (const bookId of selectedBooks) {
          await performDeleteBook(bookId);
        }
        setAllBooks(prev => prev.filter(b => !selectedBooks.has(b.id)));
        setSelectedBooks(new Set());
      } catch (err) {
        setError('Mehrfachlöschung fehlgeschlagen.');
      }
    } else {
      try {
        await performDeleteBook(showDeleteConfirm);
        setAllBooks(prev => prev.filter(b => b.id !== showDeleteConfirm));
        setSelectedBooks(prev => {
          const newSet = new Set(prev);
          newSet.delete(showDeleteConfirm);
          return newSet;
        });
      } catch (err: any) {
        let msg = 'Löschen fehlgeschlagen.';
        try {
          const info = JSON.parse(err.message);
          msg = `Löschen fehlgeschlagen: ${info.error}`;
        } catch {}
        setError(msg);
      }
    }
    setShowDeleteConfirm(null);
  };

  const generateCharacterImage = async (bookId: string, prompt: string, oldUrl?: string) => {
    setIsImageLoading(true);
    setError(null);
    try {
      // 1. Paid API key check for AI Studio UI
      if ((window as any).aistudio && typeof (window as any).aistudio.hasSelectedApiKey === 'function') {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await (window as any).aistudio.openSelectKey();
        }
      }

      // 2. Init AI
      const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API Key fehlt! Bitte in den Einstellungen der App setzen.");
      }
      const aiPaid = new GoogleGenAI({ apiKey });

      // 3. Bombenfeste Anti-Text-Logik
      const finalPrompt = prompt + ", absolutely no text, no letters, no words, no typography, no signatures, clean character digital art style, perfect illustration";

      console.log(`[Frontend] Generiere Bild für Prompt: ${finalPrompt}`);

      let response;
      try {
        response = await aiPaid.models.generateContent({
          model: IMAGE_MODEL,
          contents: {
            parts: [{ text: finalPrompt }],
          },
          config: {
            imageConfig: {
              aspectRatio: "1:1",
            }
          }
        });
      } catch (apiErr: any) {
        console.error("[Frontend] Nano Banana 2 API Fehler:", apiErr);
        throw new Error(`API Fehler (Quota, Filter oder Key?): ${apiErr.message}`);
      }

      let base64Image = '';
      if (response && response.candidates && response.candidates[0].content.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            base64Image = part.inlineData.data;
            break;
          }
        }
      }
      if (!base64Image) {
        throw new Error("Bild-Antwort der API war leer.");
      }

      // 4. Altes Bild löschen (HART)
      if (oldUrl) {
        try {
          console.log("[Frontend] Lösche altes Bild:", oldUrl);
          const oldRef = ref(storage, oldUrl);
          await deleteObject(oldRef);
        } catch (delErr: any) {
          console.error("[Frontend] Warnung: Konnte altes Bild nicht aus Firestore löschen:", delErr);
          // Wir werfen keinen Fehler, damit der Prozess weitergeht!
        }
      }

      // 5. Neues Bild im Firebase Storage speichern
      const storageRef = ref(storage, `buecher/${bookId}/charakter_avatar_${Date.now()}.png`);
      let url = "";
      try {
        const blob = await fetch(`data:image/png;base64,${base64Image}`).then(r => r.blob());
        await uploadBytes(storageRef, blob);
        url = await getDownloadURL(storageRef);
      } catch (uploadErr: any) {
        console.error("[Frontend] Storage Upload Fehler:", uploadErr);
        throw new Error(`Storage Upload fehlgeschlagen: ${uploadErr.message}`);
      }

      // 6. DB Update
      try {
        await updateDoc(doc(db, 'buecher', bookId), {
          'hauptcharakter.avatar_url': url
        });
      } catch (dbErr: any) {
        console.error("[Frontend] DB Update Fehler:", dbErr);
        throw new Error(`Konnte die URL nicht in Firestore speichern: ${dbErr.message}`);
      }

      // Tracker Info posten (Optional, hier über den /api Endpoint falls der Server doch läuft,
      // aber wir ignorieren Fehler falls es nur statisch läuft)
      fetch("/api/track-cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, usage: { imageGenerated: true } })
      }).catch(e => console.log("Tracking-Server nicht erreichbar, übersprungen."));

      return url;
    } catch (err: any) {
      console.error("[Frontend] Komplettabbruch generateCharacterImage:", err);
      setError(`Generierung fehlgeschlagen: ${err.message}`);
      return null;
    } finally {
      setIsImageLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FFFDF2] p-6 font-sans text-slate-800">
      <header className="mb-10 flex items-center justify-between">
        <h1 className="text-4xl font-bold tracking-tight text-orange-600">Kinderbuch Zauber</h1>
        <div className="flex gap-4">
          <button onClick={handleDownloadBackup} className="rounded-full bg-slate-100 px-6 py-3 font-bold text-slate-700">Backup laden</button>
          <button onClick={() => { signOut(auth); setIsDevMode(false); }} className="rounded-full bg-slate-800 px-6 py-3 font-bold text-white">Ausloggen</button>
        </div>
      </header>
      
      <main className="mx-auto max-w-3xl">
        <div className="flex gap-4 border-b border-orange-200 mb-8">
          <button onClick={() => setActiveTab('create')} className={`p-4 font-bold border-b-4 transition ${activeTab === 'create' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Neue Geschichte</button>
          <button onClick={() => setActiveTab('library')} className={`p-4 font-bold border-b-4 transition ${activeTab === 'library' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Meine Geschichten ({allBooks.length})</button>
        </div>

        {activeTab === 'create' ? (
          <>
            {currentUser?.email === ADMIN_EMAIL && <AdminDashboard allBooks={allBooks} />}
            <div className="mb-8 rounded-[40px] bg-white p-8 shadow-xl border-4 border-orange-50">
              <textarea
                id="ideaTextarea"
                className="w-full rounded-3xl bg-slate-50 border-2 border-slate-100 p-6 text-lg focus:outline-none focus:border-orange-200 transition-all"
                rows={4}
                placeholder="Beschreibe deine Buchidee..."
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
              />
              <button
                id="generateButton"
                onClick={handleGenerate}
                disabled={isLoading || !idea}
                className="mt-6 w-full rounded-3xl bg-orange-500 py-5 text-xl font-bold text-white transition-all shadow-[0_8px_0_rgb(194,65,12)] active:translate-y-1 active:shadow-none disabled:bg-slate-300 disabled:shadow-none"
              >
                {isLoading ? "Zaubere..." : "✨ Magie wirken lassen"}
              </button>
            </div>
            {error && (
              <div className="mb-6 rounded-2xl bg-red-100 p-4 text-red-800 border border-red-200">
                {error}
              </div>
            )}
            {result && (
              <div className="space-y-8 animate-in fade-in duration-700">
                <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {result.titel_optionen.map((titel, i) => (
                    <div 
                      key={i} 
                      onClick={() => {
                        updateDoc(doc(db, 'buecher', result.id), { ausgewaehlter_titel: titel });
                        setResult({ ...result, ausgewaehlter_titel: titel });
                      }}
                      className={`cursor-pointer rounded-2xl border-2 p-4 text-center font-bold transition hover:shadow-sm ${
                        result.ausgewaehlter_titel === titel 
                          ? 'bg-orange-100 border-orange-500 text-orange-800' 
                          : 'bg-white border-slate-100 text-slate-700 hover:border-orange-200'
                      }`}
                    >
                      {titel}
                    </div>
                  ))}
                </section>
                
                <section className="rounded-[40px] bg-white p-8 shadow-md border-2 border-slate-100">
                  <h2 className="mb-6 text-2xl font-bold text-slate-800">Die Story</h2>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="rounded-3xl bg-yellow-50 p-6 border border-yellow-100">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-yellow-600 mb-2">Anfang</h3>
                      <textarea
                        className="w-full text-sm leading-relaxed text-yellow-900 bg-transparent resize-none outline-none"
                        rows={6}
                        value={result.storyline.anfang}
                        onChange={(e) => setResult({ ...result, storyline: { ...result.storyline, anfang: e.target.value } })}
                        onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'storyline.anfang': result.storyline.anfang })}
                      />
                    </div>
                    <div className="rounded-3xl bg-pink-50 p-6 border border-pink-100">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-pink-600 mb-2">Mitte</h3>
                      <textarea
                        className="w-full text-sm leading-relaxed text-pink-900 bg-transparent resize-none outline-none"
                        rows={6}
                        value={result.storyline.mitte}
                        onChange={(e) => setResult({ ...result, storyline: { ...result.storyline, mitte: e.target.value } })}
                        onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'storyline.mitte': result.storyline.mitte })}
                      />
                    </div>
                    <div className="rounded-3xl bg-purple-50 p-6 border border-purple-100">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-purple-600 mb-2">Ende</h3>
                      <textarea
                        className="w-full text-sm leading-relaxed text-purple-900 bg-transparent resize-none outline-none"
                        rows={6}
                        value={result.storyline.ende}
                        onChange={(e) => setResult({ ...result, storyline: { ...result.storyline, ende: e.target.value } })}
                        onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'storyline.ende': result.storyline.ende })}
                      />
                    </div>
                  </div>
                </section>
                
                <section className="rounded-[40px] bg-[#F2FCEF] p-8 shadow-md border-2 border-green-100">
                  <div className="flex flex-col md:flex-row gap-6">
                    <div className="flex-1">
                      <h2 className="mb-2 text-2xl font-bold text-green-800">Held: {result.hauptcharakter.name}</h2>
                      <p className="text-sm text-green-700"><strong>Gattung:</strong> {result.hauptcharakter.gattung}</p>
                      <p className="text-sm text-green-700"><strong>Persönlichkeit:</strong> {result.hauptcharakter.persoenlichkeit}</p>
                      <p className="mt-2 text-sm text-green-900 italic">{result.hauptcharakter.aussehen_de}</p>
                    </div>
                    <div className="flex flex-col items-center gap-4">
                      <div id="characterImagePlaceholder" className="flex-none w-48 h-48 rounded-2xl bg-white flex items-center justify-center text-slate-400 border-dashed border-4 border-slate-200 overflow-hidden">
                        {isImageLoading ? (
                          <div className="flex flex-col items-center">
                            <div className="animate-spin text-4xl mb-2">⏳</div>
                            <p className="text-[10px] text-center px-1">Nano Banana 2 zeichnet {result.hauptcharakter.name}...</p>
                          </div>
                        ) : result.hauptcharakter.avatar_url ? (
                          <img src={result.hauptcharakter.avatar_url} alt="Held" className="w-full h-full object-cover" />
                        ) : (
                          <button onClick={() => generateCharacterImage(result.id, result.hauptcharakter.bild_prompt_en)} className="text-xs text-center p-2">Charakterbild generieren</button>
                        )}
                      </div>
                      
                      {currentUser?.email === ADMIN_EMAIL && result.hauptcharakter.avatar_url && (
                        <button 
                          onClick={async () => {
                            const newAvatarUrl = await generateCharacterImage(result.id, result.hauptcharakter.bild_prompt_en, result.hauptcharakter.avatar_url);
                            if (newAvatarUrl) {
                              setResult({...result, hauptcharakter: {...result.hauptcharakter, avatar_url: newAvatarUrl}});
                            }
                          }}
                          disabled={isImageLoading}
                          className="w-full max-w-48 rounded-full bg-white border border-slate-200 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-colors shadow-sm"
                        >
                          {isImageLoading ? "🔄 Generiere..." : "🔄 Bild neu generieren"}
                        </button>
                      )}
                    </div>
                  </div>
                </section>
                
                <div className="flex justify-center mt-12 pb-8">
                  <button onClick={() => {}} className="px-8 py-4 rounded-full bg-slate-900 text-white font-bold text-lg shadow-[0_4px_0_rgb(15,23,42)] hover:-translate-y-1 hover:shadow-[0_6px_0_rgb(15,23,42)] active:translate-y-1 active:shadow-none transition-all cursor-pointer">
                    Nächster Schritt: Buch ausarbeiten ➡️
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {allBooks.length > 0 && selectedBooks.size > 0 && (
              <button onClick={handleDeleteSelected} className="md:col-span-2 mb-4 bg-red-500 text-white font-bold py-3 px-6 rounded-full hover:bg-red-600 active:bg-red-700 cursor-pointer transition-colors shadow-sm cursor-pointer">
                {selectedBooks.size} Geschichten löschen
              </button>
            )}
            {allBooks.map(book => (
              <div key={book.id} className="relative rounded-[30px] bg-white p-6 shadow-sm border border-slate-100 flex flex-col gap-4">
                <input type="checkbox" onChange={() => handleToggleSelectBook(book.id)} checked={selectedBooks.has(book.id)} className="absolute top-4 left-4" />
                <img src={book.hauptcharakter.avatar_url || ''} alt="" className="w-full h-40 object-cover rounded-2xl bg-slate-100" />
                <h3 className="font-bold text-lg">{book.ausgewaehlter_titel || "Ohne Titel"}</h3>
                <div className="flex justify-between items-center text-sm font-bold text-slate-500">
                  <span>{book.created_at ? new Date(book.created_at.seconds * 1000).toLocaleDateString() : 'Unbekannt'}</span>
                  {currentUser?.email === ADMIN_EMAIL && book.cost_metrics && <span>💰 ${book.cost_metrics.total_cost_usd.toFixed(2)}</span>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditingBook(book)} className="flex-1 bg-slate-100 text-slate-700 py-2 rounded-full font-bold hover:bg-slate-200 cursor-pointer transition-colors">Bearbeiten</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteBook(book.id); }} className="bg-red-50 text-red-500 py-2 px-4 rounded-full font-bold relative z-20 cursor-pointer hover:bg-red-100 transition-colors">🗑️</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-[32px] bg-white p-8 shadow-2xl">
            <h3 className="mb-4 text-2xl font-bold text-slate-800">Wirklich löschen?</h3>
            <p className="mb-8 text-slate-600">Diese Aktion kann nicht rückgängig gemacht werden.</p>
            <div className="flex gap-4">
              <button onClick={() => setShowDeleteConfirm(null)} className="flex-1 rounded-full bg-slate-100 py-3 font-bold text-slate-700 hover:bg-slate-200 cursor-pointer">Abbrechen</button>
              <button onClick={confirmDelete} className="flex-1 rounded-full bg-red-500 py-3 font-bold text-white shadow-[0_4px_0_rgb(153,27,27)] hover:bg-red-600 active:translate-y-1 active:shadow-none cursor-pointer">Löschen</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingBook && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-4xl rounded-[40px] bg-white p-8 shadow-2xl my-8 max-h-[90vh] overflow-y-auto">
            <h3 className="mb-6 text-3xl font-bold text-slate-800">📖 Geschichte bearbeiten</h3>
            
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-bold text-slate-500 mb-2 uppercase tracking-widest">Titel</label>
                <input 
                  type="text" 
                  value={editingBook.ausgewaehlter_titel || editingBook.titel_optionen[0] || ""}
                  onChange={(e) => setEditingBook({...editingBook, ausgewaehlter_titel: e.target.value})}
                  className="w-full rounded-2xl bg-slate-50 border-2 border-slate-100 p-4 font-bold text-slate-800 text-xl focus:outline-none focus:border-orange-300 transition-colors"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-yellow-600 mb-2 uppercase tracking-widest">Anfang</label>
                  <textarea 
                    rows={8}
                    value={editingBook.storyline.anfang}
                    onChange={(e) => setEditingBook({...editingBook, storyline: {...editingBook.storyline, anfang: e.target.value}})}
                    className="w-full flex-1 rounded-2xl bg-yellow-50 border border-yellow-100 p-4 text-sm text-yellow-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-yellow-300 resize-none"
                  />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-pink-600 mb-2 uppercase tracking-widest">Mitte</label>
                  <textarea 
                    rows={8}
                    value={editingBook.storyline.mitte}
                    onChange={(e) => setEditingBook({...editingBook, storyline: {...editingBook.storyline, mitte: e.target.value}})}
                    className="w-full flex-1 rounded-2xl bg-pink-50 border border-pink-100 p-4 text-sm text-pink-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-pink-300 resize-none"
                  />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-purple-600 mb-2 uppercase tracking-widest">Ende</label>
                  <textarea 
                    rows={8}
                    value={editingBook.storyline.ende}
                    onChange={(e) => setEditingBook({...editingBook, storyline: {...editingBook.storyline, ende: e.target.value}})}
                    className="w-full flex-1 rounded-2xl bg-purple-50 border border-purple-100 p-4 text-sm text-purple-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
                  />
                </div>
              </div>

              <div className="flex flex-col items-center gap-4 bg-slate-50 p-6 rounded-[30px] border border-slate-100">
                <h4 className="font-bold text-slate-500 uppercase tracking-widest text-xs">Charakter Avatar</h4>
                {editingBook.hauptcharakter.avatar_url ? (
                  <img 
                    src={editingBook.hauptcharakter.avatar_url} 
                    alt="Charakter Avatar" 
                    className="w-48 h-48 object-cover rounded-[24px] shadow-sm mb-2"
                  />
                ) : (
                  <div className="w-48 h-48 bg-slate-200 rounded-[24px] flex items-center justify-center mb-2">
                    <span className="text-4xl">📸</span>
                  </div>
                )}
                <button
                  onClick={async () => {
                    const newAvatarUrl = await generateCharacterImage(editingBook.id, editingBook.hauptcharakter.bild_prompt_en, editingBook.hauptcharakter.avatar_url);
                    if (newAvatarUrl) {
                      setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, avatar_url: newAvatarUrl}});
                    }
                  }}
                  disabled={isImageLoading}
                  className="w-full md:w-auto px-8 rounded-full bg-slate-200 py-3 font-bold text-slate-700 hover:bg-slate-300 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {isImageLoading ? "🔄 Generiere..." : "🔄 Bild neu generieren"}
                </button>
              </div>
            </div>

            <div className="flex gap-4 mt-8 pt-6 border-t border-slate-100">
              <button 
                onClick={() => setEditingBook(null)} 
                className="flex-1 rounded-full bg-slate-100 py-4 font-bold text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
              >
                Abbrechen
              </button>
              <button 
                onClick={() => handleUpdateBook(editingBook)} 
                className="flex-1 rounded-full bg-orange-500 py-4 font-bold text-white shadow-[0_4px_0_rgb(194,65,12)] hover:bg-orange-400 active:translate-y-1 active:shadow-none transition-all cursor-pointer"
              >
                💾 Speichern
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

