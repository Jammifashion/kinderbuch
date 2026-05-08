/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
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

interface BookPage {
  pageNumber: number;
  text: string;
  imagePrompt: string;
  imageUrl?: string;
}

interface AusgearbeitetesBuch {
  id: string;
  skriptId: string;
  titel: string;
  zielalter: string;
  stimmung: string;
  seitenAnzahl: number;
  seiten: BookPage[];
  created_at: any;
  coverImage?: string;
}

interface StoryResult {
  id: string; // Add ID field
  titel_optionen: string[];
  ausgewaehlter_titel?: string;
  erzeugteBuecherCount?: number;
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
  const [activeTab, setActiveTab] = useState<'create' | 'library' | 'books'>('create');
  const [isDevMode, setIsDevMode] = useState(false);
  const [idea, setIdea] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [isGeneratingBook, setIsGeneratingBook] = useState(false);
  const [result, setResult] = useState<StoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<StoryResult | null>(null);
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | 'selected' | null>(null);
  
  const [allFinishedBooks, setAllFinishedBooks] = useState<AusgearbeitetesBuch[]>([]);
  const [selectedSkriptForBook, setSelectedSkriptForBook] = useState<StoryResult | null>(null);
  const [bookConfig, setBookConfig] = useState({ zielalter: '4-6 Jahre', stimmung: 'Lustig', seitenAnzahl: 12 });
  const [readingBook, setReadingBook] = useState<AusgearbeitetesBuch | null>(null);
  const [currentReadingPage, setCurrentReadingPage] = useState(0);
  const [touchStart, setTouchStart] = useState<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null || !readingBook) return;
    const touchEnd = e.changedTouches[0].clientX;
    const distance = touchStart - touchEnd;
    const swipeThreshold = 50;

    if (distance > swipeThreshold) {
      setCurrentReadingPage(p => Math.min(readingBook.seiten.length - 1, p + 1));
    } else if (distance < -swipeThreshold) {
      setCurrentReadingPage(p => Math.max(0, p - 1));
    }
    setTouchStart(null);
  };

  useEffect(() => {
    if (bookConfig.zielalter === '2-4 Jahre' && !['8', '12'].includes(bookConfig.seitenAnzahl.toString())) {
      setBookConfig(prev => ({ ...prev, seitenAnzahl: 12 }));
    } else if (bookConfig.zielalter === '4-6 Jahre' && !['12', '16', '24'].includes(bookConfig.seitenAnzahl.toString())) {
      setBookConfig(prev => ({ ...prev, seitenAnzahl: 16 }));
    } else if (bookConfig.zielalter === '6-8 Jahre' && !['16', '24'].includes(bookConfig.seitenAnzahl.toString())) {
      setBookConfig(prev => ({ ...prev, seitenAnzahl: 24 }));
    }
  }, [bookConfig.zielalter]);

  useEffect(() => {
    return onAuthStateChanged(auth, (authUser) => {
      setUser(authUser);
      if (authUser?.email === ADMIN_EMAIL) {
        fetchBooks();
        fetchFinishedBooks();
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

  const fetchFinishedBooks = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'ausgearbeitete_buecher'));
      const books = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AusgearbeitetesBuch));
      setAllFinishedBooks(books);
    } catch (err) {
      console.error("Error fetching finished books:", err);
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
      // PRE-CHECK
      const safetyPrompt = `Bewerte die folgende Eingabe strikt auf Kindersicherheit. Enthält sie sensible, gewalttätige, beängstigende, drogenbezogene, diskriminierende oder sexuelle Inhalte? Antworte NUR mit "UNSAFE", wenn sie ungeeignet ist, ansonsten mit "SAFE".\nEingabe: "${idea}"`;
      const safetyRes = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: safetyPrompt,
        config: {
          systemInstruction: "Du bist ein strenger Jugendschutz-Filter für Kinder von 2 bis 8 Jahren."
        }
      });
      if (safetyRes.text && safetyRes.text.trim().toUpperCase().includes('UNSAFE')) {
        setError("Ups! Dieser Inhalt ist für ein friedliches Kinderbuch leider nicht geeignet. Lass uns lieber ein schönes, positives Abenteuer erleben! 🌟");
        setIsLoading(false);
        return;
      }

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
        config: {
          systemInstruction: "UNUMSTÖßLICHE REGEL: Es dürfen ausschließlich jugendfreie, positive und pädagogisch wertvolle Inhalte für Kinder zwischen 2 und 8 Jahren erzeugt werden."
        }
      });
      // We will track cost after saving to firestore
      const text = response.text || '';
      const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
      const storyData: StoryResult = JSON.parse(cleanJson);

      // Save to Firestore
      try {
        const docRef = await addDoc(collection(db, 'buecher'), {
          ...storyData,
          erzeugteBuecherCount: 0,
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
        
        await updateBookCosts(bookId, {
          promptTokens: response.usageMetadata?.promptTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount
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
      // 0. PRE-CHECK
      const safetyPrompt = `Bewerte die folgende Eingabe auf Kindersicherheit. Enthält sie sensible, gewalttätige, beängstigende, drogenbezogene, diskriminierende oder sexuelle Inhalte? Antworte NUR mit "UNSAFE", wenn sie ungeeignet ist, sonst mit "SAFE".\nEingabe: "${prompt}"`;
      const safetyRes = await ai.models.generateContent({ model: MODEL_NAME, contents: safetyPrompt });
      if (safetyRes.text && safetyRes.text.trim().toUpperCase().includes('UNSAFE')) {
        throw new Error("Ups! Dieser Inhalt ist für ein friedliches Kinderbuch leider nicht geeignet. Lass uns lieber ein schönes, positives Abenteuer erleben! 🌟");
      }

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

      await updateBookCosts(bookId, { imageGenerated: true });

      return url;
    } catch (err: any) {
      console.error("[Frontend] Komplettabbruch generateCharacterImage:", err);
      setError(`Generierung fehlgeschlagen: ${err.message}`);
      return null;
    } finally {
      setIsImageLoading(false);
    }
  };

  const updateBookCosts = async (bookId: string, usage: { promptTokens?: number, outputTokens?: number, imageGenerated?: boolean }) => {
    try {
      const bookRef = doc(db, 'buecher', bookId);
      const bookSnap = await getDoc(bookRef);
      if (!bookSnap.exists()) return;
      const currentMetrics = bookSnap.data()?.cost_metrics || {
        text_input_tokens: 0,
        text_output_tokens: 0,
        images_generated: 0,
        total_cost_usd: 0
      };

      const inputTokens = usage.promptTokens || 0;
      const outputTokens = usage.outputTokens || 0;

      const newMetrics: any = {
        text_input_tokens: currentMetrics.text_input_tokens + inputTokens,
        text_output_tokens: currentMetrics.text_output_tokens + outputTokens,
        images_generated: currentMetrics.images_generated + (usage.imageGenerated ? 1 : 0),
      };

      newMetrics.total_cost_usd = (newMetrics.text_input_tokens / 1_000_000 * 0.075) + 
                   (newMetrics.text_output_tokens / 1_000_000 * 0.30) + 
                   (newMetrics.images_generated * 0.01);

      await updateDoc(bookRef, { cost_metrics: newMetrics });
    } catch (e) {
      console.warn("Could not update cost", e);
    }
  };

  const handleGenerateBook = async () => {
    if (!selectedSkriptForBook) return;
    setIsGeneratingBook(true);
    setError(null);
    try {
      const count = (selectedSkriptForBook.erzeugteBuecherCount || 0);
      if (count >= 3) {
          throw new Error("Limit von 3 Büchern pro Kurzskript erreicht.");
      }
      
      const { zielalter, stimmung, seitenAnzahl } = bookConfig;
      let inhaltsdichte = "Mittel";
      let bildanteil = "Mittel";
      if (zielalter === "2-4 Jahre") {
         inhaltsdichte = "Klein (Sehr einfache, kurze Sätze, ca. 1-2 Sätze pro Seite)";
         bildanteil = "Groß (Bilder dominieren die Seite vollständig)";
      } else if (zielalter === "4-6 Jahre") {
         inhaltsdichte = "Mittel (Einfache Sätze, ca. 3-4 Sätze pro Seite)";
         bildanteil = "Mittel (Bilder und Text sind ausgewogen)";
      } else if (zielalter === "6-8 Jahre") {
         inhaltsdichte = "Groß (Längere Sätze, somewhat komplexere Struktur, ca. 4-6 Sätze pro Seite)";
         bildanteil = "Klein (Text hat mehr Gewicht, Bilder untermalen die Geschichte)";
      }

      const promptStr = `
Du bist ein professioneller Kinderbuchautor. Mache aus dem folgenden Kurzskript ein vollständiges Buch, formatiert als JSON.
Die Parameter:
Zielalter: ${zielalter}
Stimmung: ${stimmung}
Seiten: ${seitenAnzahl}
Inhaltsdichte: ${inhaltsdichte}
Bildanteil: ${bildanteil}

Charakter: ${JSON.stringify(selectedSkriptForBook.hauptcharakter)}
Storyline: ${JSON.stringify(selectedSkriptForBook.storyline)}

Teile die Storyline auf EXAKT ${seitenAnzahl} Seiten auf. Passe den Wortschatz an das Zielalter und den Schreibstil an die Stimmung an (z.B. "lustig" = humorvoll, "träumerisch" = sanfte Sprache). Berücksichtige zwingend die Inhaltsdichte!

VISUELLE KONSISTENZ: Analysiere für jede Seite separat, ob der Hauptcharakter in dieser spezifischen Szene vorkommen MUSS.
- Wenn JA: Injiziere seine Charakterbeschreibung ("${selectedSkriptForBook.hauptcharakter?.aussehen_de}") prominent in den englischen 'imagePrompt'.
- Wenn NEIN: Generiere ein reines Szenen-Bild (ohne den Hauptcharakter), das exakt denselben künstlerischen Stil nutzt.

HÄNGE AN JEDEN imagePrompt DIESEN ANTI-TEXT-RIEGEL AN:
", absolutely no text, no letters, no words, no typography, no signatures, clean character digital art style, perfect illustration"

Dein Output MUSS exakt dieses JSON-Format haben:
{
  "titel": "Kreativer Titel des Buchs",
  "seiten": [
    {
      "pageNumber": 1,
      "text": "Der Text für diese Seite...",
      "imagePrompt": "Der Bild-Prompt auf Englisch..."
    }
  ]
}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: {
          parts: [{ text: promptStr }],
        },
        config: {
          responseMimeType: "application/json",
          systemInstruction: "UNUMSTÖßLICHE REGEL: Es dürfen ausschließlich jugendfreie, positive und pädagogisch wertvolle Inhalte für Kinder zwischen 2 und 8 Jahren erzeugt werden."
        }
      });
      
      await updateBookCosts(selectedSkriptForBook.id, {
        promptTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount
      });

      let txt = response.text || "{}";
      if (txt.startsWith('\`\`\`json')) txt = txt.slice(7);
      else if (txt.startsWith('\`\`\`')) txt = txt.slice(3);
      if (txt.endsWith('\`\`\`')) txt = txt.slice(0, -3);
      txt = txt.trim();

      const parsed = JSON.parse(txt);
      
      const newBookData = {
        skriptId: selectedSkriptForBook.id,
        titel: parsed.titel || "Neues Buch",
        zielalter,
        stimmung,
        seitenAnzahl,
        seiten: parsed.seiten || [],
        coverImage: selectedSkriptForBook.hauptcharakter?.avatar_url || null,
        isFavorite: false,
        labels: [],
        createdByUser: currentUser?.email,
        created_at: serverTimestamp()
      };
      
      await addDoc(collection(db, 'ausgearbeitete_buecher'), newBookData);
      
      const newCount = count + 1;
      await updateDoc(doc(db, 'buecher', selectedSkriptForBook.id), { erzeugteBuecherCount: newCount });

      setSelectedSkriptForBook(null);
      setActiveTab('books');
      fetchBooks();
      fetchFinishedBooks();
    } catch (err: any) {
      console.error(err);
      setError(err.message);
    } finally {
      setIsGeneratingBook(false);
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
        <div className="flex gap-4 border-b border-orange-200 mb-8 overflow-x-auto">
          <button onClick={() => setActiveTab('create')} className={`p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'create' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Neue Geschichte</button>
          <button onClick={() => setActiveTab('library')} className={`p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'library' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Meine Kurzskripte ({allBooks.length})</button>
          <button onClick={() => setActiveTab('books')} className={`p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'books' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Bücher ({allFinishedBooks.length})</button>
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
                  <h2 className="mb-6 text-2xl font-bold text-slate-800">Story Kurzskript</h2>
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
        ) : activeTab === 'library' ? (
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
                  <button 
                    onClick={() => setSelectedSkriptForBook(book)} 
                    disabled={(book.erzeugteBuecherCount || 0) >= 3}
                    className="flex-[2] bg-indigo-500 text-white py-2 rounded-full font-bold hover:bg-indigo-600 transition-colors shadow-sm cursor-pointer border border-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed">
                    {(book.erzeugteBuecherCount || 0) >= 3 ? "Limit erreicht (3/3)" : "📖 Buch erzeugen"}
                  </button>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditingBook(book)} className="flex-1 bg-slate-100 text-slate-700 py-2 rounded-full font-bold hover:bg-slate-200 cursor-pointer transition-colors">Bearbeiten</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteBook(book.id); }} className="bg-red-50 text-red-500 py-2 px-4 rounded-full font-bold relative z-20 cursor-pointer hover:bg-red-100 transition-colors">🗑️</button>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'books' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {allFinishedBooks.length === 0 && (
              <p className="text-slate-500 col-span-2 text-center py-12">Noch keine fertigen Bücher vorhanden.</p>
            )}
            {allFinishedBooks.map(book => (
              <div key={book.id} className="relative rounded-[30px] bg-white p-6 shadow-sm border border-slate-100 flex flex-col gap-4 cursor-pointer hover:shadow-md transition-shadow" onClick={() => setReadingBook(book)}>
                <img src={book.coverImage || ''} alt="Cover" className="w-full h-48 object-cover rounded-2xl bg-amber-50" />
                <h3 className="font-bold text-xl text-slate-800">{book.titel}</h3>
                <div className="flex flex-wrap gap-2">
                  <span className="bg-indigo-100 text-indigo-800 text-xs font-bold px-2 py-1 rounded-md">{book.zielalter}</span>
                  <span className="bg-pink-100 text-pink-800 text-xs font-bold px-2 py-1 rounded-md">{book.stimmung}</span>
                  <span className="bg-slate-100 text-slate-600 text-xs font-bold px-2 py-1 rounded-md">{book.seitenAnzahl} Seiten</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </main>

      {/* Configurator Modal */}
      {selectedSkriptForBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-[32px] bg-white p-8 shadow-2xl">
            <h3 className="mb-6 text-2xl font-bold text-slate-800">Buch Konfigurator</h3>
            
            {error && (
              <div className="mb-6 rounded-2xl bg-red-100 p-4 text-red-800 border border-red-200 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-bold text-slate-500 mb-3">Altersgruppe</label>
                <div className="flex gap-2">
                  {['2-4 Jahre', '4-6 Jahre', '6-8 Jahre'].map(alter => (
                    <button 
                      key={alter}
                      onClick={() => setBookConfig({ ...bookConfig, zielalter: alter })}
                      className={`flex-1 py-2 rounded-xl text-sm font-bold border-2 transition-colors cursor-pointer ${bookConfig.zielalter === alter ? 'border-orange-500 text-orange-600 bg-orange-50' : 'border-slate-100 text-slate-500 hover:border-slate-200'}`}
                    >
                      {alter}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-500 mb-3">Stimmung</label>
                <div className="flex flex-wrap gap-2">
                  {['Lustig', 'Träumerisch', 'Lehrreich', 'Spannend'].map(stimmung => (
                    <button 
                      key={stimmung}
                      onClick={() => setBookConfig({ ...bookConfig, stimmung })}
                      className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-colors cursor-pointer ${bookConfig.stimmung === stimmung ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-slate-100 text-slate-500 hover:border-slate-200'}`}
                    >
                      {stimmung}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-500 mb-3">Seitenanzahl</label>
                <select 
                  className="w-full rounded-xl border-2 border-slate-100 p-3 font-bold text-slate-700 outline-none focus:border-slate-300"
                  value={bookConfig.seitenAnzahl}
                  onChange={(e) => setBookConfig({ ...bookConfig, seitenAnzahl: parseInt(e.target.value) })}
                >
                  {(bookConfig.zielalter === '2-4 Jahre' ? [8, 12] : bookConfig.zielalter === '4-6 Jahre' ? [12, 16, 24] : [16, 24]).map(num => (
                    <option key={num} value={num}>{num} Seiten</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-4 mt-8 pt-6 border-t border-slate-100">
                <button onClick={() => setSelectedSkriptForBook(null)} className="flex-1 rounded-full bg-slate-100 py-3 font-bold text-slate-700 hover:bg-slate-200 cursor-pointer">Abbrechen</button>
                <button 
                  onClick={handleGenerateBook} 
                  disabled={isGeneratingBook}
                  className="flex-[2] rounded-full bg-indigo-500 py-3 font-bold text-white shadow-[0_4px_0_rgb(67,56,202)] hover:bg-indigo-600 active:translate-y-1 active:shadow-none cursor-pointer border border-indigo-400 disabled:opacity-50 disabled:translate-y-1 disabled:shadow-none"
                >
                  {isGeneratingBook ? "Wird geschrieben..." : "Buch ausarbeiten ✨"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
            <h3 className="mb-6 text-3xl font-bold text-slate-800">📖 Kurzskript bearbeiten</h3>
            
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

            <div className="flex flex-col md:flex-row gap-4 mt-8 pt-6 border-t border-slate-100">
              <button 
                onClick={() => setEditingBook(null)} 
                className="flex-1 rounded-full bg-slate-100 py-4 font-bold text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
              >
                Abbrechen
              </button>
              <button 
                onClick={() => handleUpdateBook(editingBook)} 
                className="flex-1 rounded-full bg-orange-100 py-4 font-bold text-orange-700 hover:bg-orange-200 transition-colors cursor-pointer"
              >
                💾 Speichern
              </button>
              <button 
                onClick={async () => {
                  await handleUpdateBook(editingBook);
                  setSelectedSkriptForBook(editingBook);
                  setEditingBook(null);
                }} 
                className="flex-[2] rounded-full bg-slate-900 py-4 font-bold text-white shadow-[0_4px_0_rgb(15,23,42)] hover:-translate-y-1 hover:shadow-[0_6px_0_rgb(15,23,42)] active:translate-y-1 active:shadow-none transition-all cursor-pointer"
              >
                Weiter: Buch ausarbeiten ➡️
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reader Modal */}
      {readingBook && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-slate-900 text-white">
          <div className="flex justify-between items-center p-4 bg-slate-800/80 backdrop-blur-md absolute top-0 w-full z-[80]">
            <h3 className="font-bold truncate px-4">{readingBook.titel}</h3>
            <button onClick={() => { setReadingBook(null); setCurrentReadingPage(0); }} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-full cursor-pointer transition-colors shrink-0">Schließen</button>
          </div>

          <div className="flex-1 flex items-center justify-center relative overflow-hidden pt-16">
            <button 
              onClick={() => setCurrentReadingPage(p => Math.max(0, p - 1))}
              disabled={currentReadingPage === 0}
              className="absolute left-2 md:left-8 z-[90] w-12 h-12 bg-black/50 rounded-full flex items-center justify-center text-2xl disabled:opacity-20 cursor-pointer backdrop-blur-md transition-all hover:bg-black/70"
            >
              ◀
            </button>
            <button 
              onClick={() => setCurrentReadingPage(p => Math.min(readingBook.seiten.length - 1, p + 1))}
              disabled={currentReadingPage === readingBook.seiten.length - 1}
              className="absolute right-2 md:right-8 z-[90] w-12 h-12 bg-black/50 rounded-full flex items-center justify-center text-2xl disabled:opacity-20 cursor-pointer backdrop-blur-md transition-all hover:bg-black/70"
            >
              ▶
            </button>

            <div 
              className="w-full max-w-2xl h-full flex items-center justify-center relative px-4 md:px-16 pb-8 touch-pan-y"
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              {readingBook.seiten.map((seite, idx) => {
                const isRendered = Math.abs(idx - currentReadingPage) <= 1;
                const isActive = idx === currentReadingPage;
                const translatePercent = (idx - currentReadingPage) * 100;
                
                if (!isRendered) return null;

                return (
                  <div 
                    key={idx} 
                    className="absolute w-full h-[85%] px-4 md:px-8 flex flex-col transition-transform duration-300 ease-in-out"
                    style={{ transform: `translateX(${translatePercent}%)`, opacity: isActive ? 1 : 0.3 }}
                  >
                    <div className="flex-[3] bg-white rounded-t-[32px] overflow-hidden flex items-center justify-center relative shadow-xl">
                      {seite.imageUrl ? (
                        <img src={seite.imageUrl} alt={`Seite ${idx + 1}`} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                         <div className="flex flex-col items-center justify-center h-full w-full bg-slate-100 text-slate-500 p-6 overflow-hidden">
                           <span className="text-sm border-2 border-dashed border-slate-300 p-4 rounded-3xl overflow-auto text-center italic w-full h-full">"{seite.imagePrompt}"</span>
                           <button className="bg-indigo-500 text-white px-6 py-3 rounded-full font-bold shadow-sm transition-colors hover:bg-indigo-600 mt-4 cursor-pointer">Bilder zaubern (Demnächst)</button>
                         </div>
                      )}
                    </div>
                    <div className="flex-[2] overflow-y-auto bg-slate-800 rounded-b-[32px] p-6 shadow-2xl z-10 border-t-4 border-slate-900 leading-relaxed">
                      <p className="text-lg md:text-xl">{seite.text}</p>
                      <p className="text-right text-xs text-slate-500 mt-4">{idx + 1} / {readingBook.seiten.length}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

