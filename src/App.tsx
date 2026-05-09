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
  layoutType?: 'text-only' | 'image-only' | 'stacked';
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
  isFavorite?: boolean;
  labelId?: string | null;
  createdByUser?: string;
}

export type CustomLabel = {
  id: string;
  name: string;
  colorClass: string;
};

export const DEFAULT_LABELS: CustomLabel[] = [
  { id: '1', name: 'Sternchen', colorClass: 'bg-yellow-100 text-yellow-800' },
  { id: '2', name: 'Wichtig', colorClass: 'bg-red-100 text-red-800' },
  { id: '3', name: 'Spaß', colorClass: 'bg-green-100 text-green-800' },
  { id: '4', name: 'Lernen', colorClass: 'bg-blue-100 text-blue-800' },
  { id: '5', name: 'Familie', colorClass: 'bg-purple-100 text-purple-800' }
];

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


export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [allBooks, setAllBooks] = useState<StoryResult[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'create' | 'library' | 'books'>('dashboard');
  const [isDevMode, setIsDevMode] = useState(false);
  const [idea, setIdea] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [isGeneratingBook, setIsGeneratingBook] = useState(false);
  const [generationStep, setGenerationStep] = useState<string>('');
  const [result, setResult] = useState<StoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<StoryResult | null>(null);
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | 'selected' | null>(null);
  const [showDeleteFinishedConfirm, setShowDeleteFinishedConfirm] = useState<string | null>(null);
  
  const [isBackupManagerOpen, setIsBackupManagerOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [autoBackups, setAutoBackups] = useState<any[]>([]);
  const [isBackupLoading, setIsBackupLoading] = useState(false);
  
  const [allFinishedBooks, setAllFinishedBooks] = useState<AusgearbeitetesBuch[]>([]);
  const [selectedSkriptForBook, setSelectedSkriptForBook] = useState<StoryResult | null>(null);
  const [bookConfig, setBookConfig] = useState({ zielalter: '4-6 Jahre', stimmung: 'Lustig', seitenAnzahl: 12 });
  const [readingBook, setReadingBook] = useState<AusgearbeitetesBuch | null>(null);
  const [currentReadingPage, setCurrentReadingPage] = useState(0);
  const [editingPageIdx, setEditingPageIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [showOnlyFavorites, setShowOnlyFavorites] = useState(false);
  const [activeLabelFilter, setActiveLabelFilter] = useState<string | null>(null);
  
  // Custom Labels
  const [customLabels, setCustomLabels] = useState<CustomLabel[]>(() => {
    const saved = localStorage.getItem('jammi_custom_labels');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return DEFAULT_LABELS;
  });
  const [isEditingLabels, setIsEditingLabels] = useState(false);
  const [editingCustomLabels, setEditingCustomLabels] = useState<CustomLabel[]>([...customLabels]);

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

  const Dashboard = () => {
    const [liveSpend, setLiveSpend] = useState<number | null>(null);

    useEffect(() => {
        async function fetchBilling() {
            try {
                const token = await auth.currentUser?.getIdToken();
                if (!token) return;
                const response = await fetch('/api/admin/live-billing', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    setLiveSpend(data.currentSpend);
                }
            } catch (e) {
                console.error("Billing fetch failed, falling back to local estimate.", e);
            }
        }
        fetchBilling();
    }, []);

    return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6">
        <button onClick={() => setActiveTab('create')} className="bg-white p-8 rounded-[32px] shadow-sm border border-slate-100 hover:border-orange-200 transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">✍️</span>
          <span className="font-bold text-xl text-slate-800">Neue Geschichte schreiben</span>
        </button>
        <button onClick={() => setActiveTab('library')} className="bg-white p-8 rounded-[32px] shadow-sm border border-slate-100 hover:border-orange-200 transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">📜</span>
          <span className="font-bold text-xl text-slate-800">Meine Kurzskripte ({allBooks.length})</span>
        </button>
        <button onClick={() => setActiveTab('books')} className="bg-white p-8 rounded-[32px] shadow-sm border border-slate-100 hover:border-orange-200 transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">📚</span>
          <span className="font-bold text-xl text-slate-800">Meine Bücher ({allFinishedBooks.length})</span>
        </button>
        <button onClick={() => setIsBackupManagerOpen(true)} className="bg-white p-8 rounded-[32px] shadow-sm border border-slate-100 hover:border-orange-200 transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">💾</span>
          <span className="font-bold text-xl text-slate-800">Backup-Manager</span>
        </button>
      </div>

      <div className="bg-white p-6 rounded-3xl border border-slate-100 flex items-center justify-between shadow-sm">
        <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Kostenübersicht {liveSpend !== null ? '(Live)' : '(Geschätzt)'}</div>
        <div className="font-bold text-slate-800">{liveSpend !== null ? `$${liveSpend.toFixed(2)}` : `$${stats.total.toFixed(2)}`}</div>
      </div>
    </div>
  );
};

  useEffect(() => {
    localStorage.setItem('jammi_custom_labels', JSON.stringify(customLabels));
  }, [customLabels]);

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
        checkAndCreateAutoBackup();
      }
    });
  }, []);

  const checkAndCreateAutoBackup = async () => {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const backupsRef = collection(db, 'automatisierte_backups');
      const querySnapshot = await getDocs(backupsRef);
      const existingBackups = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
      
      const hasToday = existingBackups.some(b => b.dateString === today);
      if (!hasToday) {
        // Create auto backup
        const buecherSnap = await getDocs(collection(db, 'buecher'));
        const ausBuecherSnap = await getDocs(collection(db, 'ausgearbeitete_buecher'));
        
        const backupData = {
          dateString: today,
          created_at: serverTimestamp(),
          buecher: buecherSnap.docs.map(d => ({ id: d.id, ...d.data() })),
          ausgearbeitete_buecher: ausBuecherSnap.docs.map(d => ({ id: d.id, ...d.data() })),
          customLabels: JSON.parse(localStorage.getItem('jammi_custom_labels') || '[]')
        };
        
        await addDoc(backupsRef, backupData);
        setAutoBackups([...existingBackups, { id: 'temp', ...backupData }].sort((a,b) => b.dateString.localeCompare(a.dateString)).slice(0,7));
      } else {
        setAutoBackups(existingBackups.sort((a,b) => b.dateString.localeCompare(a.dateString)).slice(0,7));
      }
    } catch (e) {
      console.error("Auto Backup Failed:", e);
    }
  };

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
    if (!idea.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      // 0. LOCAL KEYWORD PRE-CHECK
      const blockedKeywords = ['tod', 'blut', 'mord', 'töten', 'krieg', 'gewalt', 'sex', 'porno', 'droge', 'waffe', 'schießen', 'sterben', 'schlagen', 'hassen'];
      const ideaLower = idea.toLowerCase();
      const hasBlockedWord = blockedKeywords.some(word => ideaLower.includes(word));
      
      if (hasBlockedWord) {
        setError("Ups! Das ist ein bisschen zu wild für ein friedliches Kinderbuch... Lass uns lieber ein schönes, positives Abenteuer erleben! 🌟");
        setIsLoading(false);
        return;
      }

      // 1. AI PRE-CHECK
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
    setIsBackupLoading(true);
    try {
      const buecherSnap = await getDocs(collection(db, 'buecher'));
      const ausBuecherSnap = await getDocs(collection(db, 'ausgearbeitete_buecher'));
      
      const data = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        buecher: buecherSnap.docs.map(doc => ({ backup_original_id: doc.id, ...doc.data() })),
        ausgearbeitete_buecher: ausBuecherSnap.docs.map(doc => ({ backup_original_id: doc.id, ...doc.data() })),
        customLabels: customLabels
      };
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kinderbuch_backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
    } catch (err) {
      setError('Backup konnte nicht erstellt werden.');
    } finally {
      setIsBackupLoading(false);
    }
  };

  const handleUploadBackup = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsBackupLoading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);
        
        if (data.customLabels) {
          setCustomLabels(data.customLabels);
        }
        
        const buecherSnap = await getDocs(collection(db, 'buecher'));
        const existingBuecher = new Set(buecherSnap.docs.map(d => d.id));
        
        const ausBuecherSnap = await getDocs(collection(db, 'ausgearbeitete_buecher'));
        const existingAusBuecher = new Set(ausBuecherSnap.docs.map(d => d.id));
        
        let restoredBooks = 0;
        let restoredAusBooks = 0;
        
        if (data.buecher && Array.isArray(data.buecher)) {
          for (const item of data.buecher) {
            const docId = item.backup_original_id || item.id;
            if (docId && !existingBuecher.has(docId)) {
                const { backup_original_id, id, ...rest } = item;
                await updateDoc(doc(db, 'buecher', docId), rest).catch(async () => {
                    await addDoc(collection(db, 'buecher'), rest);
                });
                restoredBooks++;
            }
          }
        }
        
        if (data.ausgearbeitete_buecher && Array.isArray(data.ausgearbeitete_buecher)) {
          for (const item of data.ausgearbeitete_buecher) {
            const docId = item.backup_original_id || item.id;
            if (docId && !existingAusBuecher.has(docId)) {
                const { backup_original_id, id, ...rest } = item;
                await updateDoc(doc(db, 'ausgearbeitete_buecher', docId), rest).catch(async () => {
                    await addDoc(collection(db, 'ausgearbeitete_buecher'), rest);
                });
                restoredAusBooks++;
            }
          }
        }
        
        alert(`Backup erfolgreich gemerged! ${restoredBooks} Kurzskripte und ${restoredAusBooks} Bücher wurden wiederhergestellt. Bereits existierende Daten wurden zum Schutz nicht überschrieben.`);
        
        fetchBooks();
        fetchFinishedBooks();
        
      } catch (err: any) {
        alert("Fehler beim Lesen des Backups: " + err.message);
      } finally {
        setIsBackupLoading(false);
        setIsBackupManagerOpen(false);
        event.target.value = ''; // Reset file input
      }
    };
    reader.readAsText(file);
  };

  const handleRestoreAutoBackup = async (backupData: any) => {
    setIsBackupLoading(true);
    try {
      if (backupData.customLabels) {
        setCustomLabels(backupData.customLabels);
      }
      
      const buecherSnap = await getDocs(collection(db, 'buecher'));
      const existingBuecher = new Set(buecherSnap.docs.map(d => d.id));
      
      const ausBuecherSnap = await getDocs(collection(db, 'ausgearbeitete_buecher'));
      const existingAusBuecher = new Set(ausBuecherSnap.docs.map(d => d.id));
      
      let restoredBooks = 0;
      let restoredAusBooks = 0;
      
      if (backupData.buecher && Array.isArray(backupData.buecher)) {
        for (const item of backupData.buecher) {
          const docId = item.backup_original_id || item.id;
          if (docId && !existingBuecher.has(docId)) {
              const { backup_original_id, id, ...rest } = item;
              await updateDoc(doc(db, 'buecher', docId), rest).catch(async () => {
                  await addDoc(collection(db, 'buecher'), rest);
              });
              restoredBooks++;
          }
        }
      }
      
      if (backupData.ausgearbeitete_buecher && Array.isArray(backupData.ausgearbeitete_buecher)) {
        for (const item of backupData.ausgearbeitete_buecher) {
          const docId = item.backup_original_id || item.id;
          if (docId && !existingAusBuecher.has(docId)) {
              const { backup_original_id, id, ...rest } = item;
              await updateDoc(doc(db, 'ausgearbeitete_buecher', docId), rest).catch(async () => {
                  await addDoc(collection(db, 'ausgearbeitete_buecher'), rest);
              });
              restoredAusBooks++;
          }
        }
      }
      
      alert(`Auto-Backup geladen! ${restoredBooks} Kurzskripte und ${restoredAusBooks} Bücher wurden wiederhergestellt.`);
      
      fetchBooks();
      fetchFinishedBooks();
    } catch (err: any) {
      alert("Fehler beim Laden des Auto-Backups: " + err.message);
    } finally {
      setIsBackupLoading(false);
      setIsBackupManagerOpen(false);
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

  const handleToggleFavorite = async (e: React.MouseEvent, book: AusgearbeitetesBuch) => {
    e.stopPropagation();
    try {
      const isFav = !book.isFavorite;
      await updateDoc(doc(db, 'ausgearbeitete_buecher', book.id), { isFavorite: isFav });
      setAllFinishedBooks(prev => prev.map(b => b.id === book.id ? { ...b, isFavorite: isFav } : b));
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleSavePageText = async (idx: number) => {
    if (!readingBook) return;
    try {
      const newSeiten = [...readingBook.seiten];
      newSeiten[idx] = { ...newSeiten[idx], text: editingText };
      
      await updateDoc(doc(db, 'ausgearbeitete_buecher', readingBook.id), { seiten: newSeiten });
      setReadingBook({ ...readingBook, seiten: newSeiten });
      setAllFinishedBooks(prev => prev.map(b => b.id === readingBook.id ? { ...b, seiten: newSeiten } : b));
      setEditingPageIdx(null);
    } catch (err: any) {
      console.error(err);
      alert("Fehler beim Speichern des Textes.");
    }
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

  const confirmDeleteFinishedBook = async () => {
    if (!showDeleteFinishedConfirm) return;
    try {
      await deleteDoc(doc(db, 'ausgearbeitete_buecher', showDeleteFinishedConfirm));
      setAllFinishedBooks(prev => prev.filter(b => b.id !== showDeleteFinishedConfirm));
    } catch (err: any) {
      handleFirestoreError(err, OperationType.DELETE, `ausgearbeitete_buecher/${showDeleteFinishedConfirm}`);
    }
    setShowDeleteFinishedConfirm(null);
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
    setGenerationStep('Die Geschichte wird gewebt...');
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

LAYOUT-REGELN:
- Für "2-4 Jahre" und "4-6 Jahre": Trenne Bild und Text strikt auf separate Seiten (layoutType "text-only" oder "image-only").
  Das Buch MUSS abwechselnd aus Text- und Bildseiten bestehen (Seite 1: Text, Seite 2: Bild, Seite 3: Text...).
  Bei Text-Seiten: Erhöhe die Erzähltiefe (3-5 Sätze für 2-4J, 5-8 Sätze für 4-6J). Das Feld 'imagePrompt' bleibt leer ("").
  Bei Bild-Seiten: Das Feld 'text' bleibt leer (""). Erzeuge einen hochqualitativen 'imagePrompt'.
- Für "6-8 Jahre": Nutze layoutType "stacked". Hier sind Bild und Text auf JEDER Seite (Bild oben, Text unten).

VISUELLE KONSISTENZ: Analysiere für jede Bild-Anforderung separat, ob der Hauptcharakter vorkommen MUSS.
- Wenn JA: Injiziere seine Beschreibung ("${selectedSkriptForBook.hauptcharakter?.aussehen_de}") prominent in den englischen 'imagePrompt'.
- HÄNGE AN JEDEN imagePrompt DIESEN ANTI-TEXT-RIEGEL AN: ", absolutely no text, no letters, no words, no typography, no signatures, clean character digital art style, perfect illustration"

Dein Output MUSS exakt dieses JSON-Format haben:
{
  "titel": "Kreativer Titel des Buchs",
  "seiten": [
    {
      "pageNumber": 1,
      "layoutType": "text-only", 
      "text": "Der Text für diese Seite...",
      "imagePrompt": ""
    },
    {
      "pageNumber": 2,
      "layoutType": "image-only",
      "text": "",
      "imagePrompt": "Der Bild-Prompt..."
    }
    // ... insgesamt genau ${seitenAnzahl} Seiten
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
      const cleanJson = txt.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      
      // --- EDITORIAL CHECK (Word Budget) ---
      const wordLimit = zielalter === '2-4 Jahre' ? 20 : (zielalter === '4-6 Jahre' ? 35 : 40);
      let pages = (parsed.seiten || []) as BookPage[];
      
      let needsCorrection = false;
      for (const p of pages) {
        if (p.text && p.text.split(/\s+/).filter(w => w.length > 0).length > wordLimit) {
            needsCorrection = true;
            break;
        }
      }

      if (needsCorrection) {
        setGenerationStep('Waschbär Paul feilt noch an den feinsten Sätzen... ✏️');
        for (let i = 0; i < pages.length; i++) {
          const words = pages[i].text.split(/\s+/).filter(w => w.length > 0);
          if (words.length > wordLimit) {
            const correctionPrompt = `Du bist ein professioneller Kinderbuch-Lektor. Kürze den folgenden Text für die Altersgruppe "${zielalter}" auf MAXIMAL ${wordLimit} Wörter. Behalte den emotionalen Kern und die Story-Kontinuität bei. Antworte NUR mit dem gekürzten Text, ohne Metatext oder Erklärungen.\n\nText: "${pages[i].text}"`;
            
            const correctionRes = await ai.models.generateContent({
              model: MODEL_NAME,
              contents: correctionPrompt
            });
            
            if (correctionRes.text) {
              pages[i].text = correctionRes.text.trim();
            }
          }
        }
      }

      const newBookData = {
        skriptId: selectedSkriptForBook.id,
        titel: parsed.titel || "Neues Buch",
        zielalter,
        stimmung,
        seitenAnzahl,
        seiten: pages,
        coverImage: selectedSkriptForBook.hauptcharakter?.avatar_url || null,
        isFavorite: false,
        labelId: null,
        createdByUser: currentUser?.email,
        created_at: serverTimestamp()
      };
      
      const docRef = await addDoc(collection(db, 'ausgearbeitete_buecher'), newBookData);
      
      const newCount = count + 1;
      await updateDoc(doc(db, 'buecher', selectedSkriptForBook.id), { erzeugteBuecherCount: newCount });

      setSelectedSkriptForBook(null);
      setActiveTab('books');
      fetchBooks();
      fetchFinishedBooks();
      setReadingBook({ id: docRef.id, ...newBookData } as AusgearbeitetesBuch);
    } catch (err: any) {
      console.error(err);
      setError(err.message);
    } finally {
      setIsGeneratingBook(false);
    }
  };

  const handleSetLabel = async (book: AusgearbeitetesBuch, labelId: string | null) => {
    try {
      const bookRef = doc(db, 'ausgearbeitete_buecher', book.id);
      
      // If clicking the same label, remove it (toggle off)
      const newLabelId = book.labelId === labelId ? null : labelId;
      
      await updateDoc(bookRef, { labelId: newLabelId });
      setAllFinishedBooks(prev => prev.map(b => b.id === book.id ? { ...b, labelId: newLabelId } : b));
    } catch (e: any) {
      console.error("Error setting label: ", e);
      alert("Fehler beim Setzen des Labels: " + e.message);
    }
  };

  const filteredFinishedBooks = allFinishedBooks.filter(b => {
    if (showOnlyFavorites && !b.isFavorite) return false;
    if (activeLabelFilter && b.labelId !== activeLabelFilter) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-[#FFFDF2] p-4 sm:p-6 font-sans text-slate-800 w-full max-w-full overflow-x-hidden relative">
      <header className="mb-4 sm:mb-10 flex items-center justify-between mt-2 sm:mt-4 relative z-40 bg-[#FFFDF2]">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-orange-600">Kinderbuch Zauber</h1>
        
        {/* Desktop Buttons */}
        <div className="hidden md:flex gap-4">
          <button onClick={() => setIsBackupManagerOpen(true)} className="rounded-full bg-slate-100 flex items-center justify-center w-12 h-12 text-2xl font-bold text-slate-700 hover:bg-slate-200 transition-colors shadow-sm cursor-pointer" title="Backup-Manager">💾</button>
          <button onClick={() => { signOut(auth); setIsDevMode(false); }} className="rounded-full bg-slate-800 px-6 py-3 font-bold text-white shadow-sm cursor-pointer whitespace-nowrap">Ausloggen</button>
        </div>

        {/* Mobile Burger Icon */}
        <button 
          onClick={() => setIsMobileMenuOpen(true)} 
          className="md:hidden flex items-center justify-center w-10 h-10 bg-white rounded-full shadow-sm text-lg cursor-pointer text-slate-700 border border-slate-100 hover:bg-slate-50 transition-colors"
        >
          ☰
        </button>
      </header>
      
      <main className="mx-auto max-w-3xl">
        <div className="hidden md:flex gap-2 sm:gap-4 border-b border-orange-200 mb-8 overflow-x-auto pb-2 scrollbar-hide">
          <button onClick={() => setActiveTab('dashboard')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'dashboard' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Start</button>
          <button onClick={() => setActiveTab('create')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'create' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Neue Geschichte</button>
          <button onClick={() => setActiveTab('library')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'library' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Meine Kurzskripte ({allBooks.length})</button>
          <button onClick={() => setActiveTab('books')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'books' ? 'border-orange-500 text-orange-600' : 'border-transparent text-slate-500 hover:text-orange-500'}`}>Bücher ({allFinishedBooks.length})</button>
        </div>

        {activeTab === 'dashboard' ? <Dashboard /> : activeTab === 'create' ? (
          <>
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
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center bg-white p-4 rounded-[24px] shadow-sm border border-slate-100 flex-wrap gap-4">
              <label className="flex items-center gap-3 font-bold text-slate-700 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={showOnlyFavorites} 
                  onChange={(e) => setShowOnlyFavorites(e.target.checked)}
                  className="w-5 h-5 rounded text-indigo-500 focus:ring-indigo-500 border-slate-300"
                />
                ❤️ Nur Favoriten anzeigen
              </label>
              {activeLabelFilter && (() => {
                const activeCfg = customLabels.find(l => l.id === activeLabelFilter);
                return (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500 font-medium">Filter:</span>
                    <span className={`text-sm font-bold px-3 py-1 rounded-full flex items-center gap-2 shadow-sm ${activeCfg?.colorClass || 'bg-slate-100 text-slate-800'}`}>
                      {activeCfg?.name || activeLabelFilter}
                      <button 
                        onClick={() => setActiveLabelFilter(null)}
                        className="opacity-70 hover:opacity-100 rounded-full w-4 h-4 flex items-center justify-center transition-opacity"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                );
              })()}
              <button 
                onClick={() => setIsEditingLabels(true)}
                className="text-sm font-medium text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 px-3 py-1.5 rounded-full transition-colors flex items-center gap-2"
              >
                🏷️ Labels anpassen
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {filteredFinishedBooks.length === 0 && (
                <p className="text-slate-500 col-span-2 text-center py-12">Noch keine {showOnlyFavorites ? 'favorisierten ' : ''}Bücher vorhanden.</p>
              )}
              {filteredFinishedBooks.map(book => (
                <div key={book.id} className="relative rounded-[30px] bg-white p-6 shadow-sm border border-slate-100 flex flex-col gap-4 cursor-pointer hover:shadow-md transition-shadow" onClick={() => setReadingBook(book)}>
                  <button 
                    onClick={(e) => handleToggleFavorite(e, book)} 
                    className="absolute top-8 right-8 z-10 w-10 h-10 bg-white/80 backdrop-blur-md rounded-full flex items-center justify-center text-xl shadow-sm hover:scale-110 transition-transform cursor-pointer"
                  >
                    {book.isFavorite ? '❤️' : '🤍'}
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setShowDeleteFinishedConfirm(book.id); }} 
                    className="absolute top-8 left-8 z-10 w-10 h-10 bg-white/80 backdrop-blur-md rounded-full flex items-center justify-center text-xl shadow-sm hover:scale-110 hover:bg-red-50 transition-all cursor-pointer"
                    title="Buch löschen"
                  >
                    🗑️
                  </button>
                  <img src={book.coverImage || ''} alt="Cover" className="w-full h-48 object-cover rounded-2xl bg-amber-50" />
                  <h3 className="font-bold text-xl text-slate-800">{book.titel}</h3>
                  <div className="flex flex-wrap gap-2">
                    <span className="bg-indigo-100 text-indigo-800 text-xs font-bold px-2 py-1 rounded-md">{book.zielalter}</span>
                    <span className="bg-pink-100 text-pink-800 text-xs font-bold px-2 py-1 rounded-md">{book.stimmung}</span>
                    <span className="bg-slate-100 text-slate-600 text-xs font-bold px-2 py-1 rounded-md">{book.seitenAnzahl} Seiten</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2 pt-4 border-t border-slate-50">
                    <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">Label:</span>
                    <div className="flex gap-2">
                      {customLabels.map(l => {
                        const isActive = book.labelId === l.id;
                        return (
                          <button
                            key={l.id}
                            onClick={(e) => { e.stopPropagation(); handleSetLabel(book, l.id); }}
                            title={l.name}
                            className={`w-6 h-6 rounded-full transition-all border-2 ${isActive ? l.colorClass + ' border-transparent scale-110 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                          />
                        );
                      })}
                    </div>
                    {book.labelId && (() => {
                      const activeLabel = customLabels.find(l => l.id === book.labelId);
                      return activeLabel ? (
                        <span 
                          onClick={(e) => { e.stopPropagation(); setActiveLabelFilter(book.labelId); }}
                          className={`ml-auto text-[10px] font-bold px-3 py-1 rounded-full cursor-pointer transition-colors shadow-sm ${activeLabel.colorClass} hover:opacity-80`}
                        >
                          {activeLabel.name}
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </main>

      {/* Book Generation Loading Overlay */}
      {isGeneratingBook && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-indigo-900/90 backdrop-blur-md p-8 text-center">
            <div className="w-24 h-24 bg-white/20 rounded-full flex items-center justify-center animate-bounce mb-8 shadow-2xl">
              <span className="text-5xl">📖</span>
            </div>
            <h2 className="text-3xl font-bold text-white mb-4">{generationStep}</h2>
            <div className="flex gap-2">
              <div className="w-3 h-3 bg-white rounded-full animate-bounce delay-75"></div>
              <div className="w-3 h-3 bg-white rounded-full animate-bounce delay-150"></div>
              <div className="w-3 h-3 bg-white rounded-full animate-bounce delay-300"></div>
            </div>
            <p className="mt-8 text-indigo-200 text-sm italic">"Geduld ist die Zauberzutat für gute Geschichten..."</p>
        </div>
      )}

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

      {/* Delete Finished Book Confirmation Modal */}
      {showDeleteFinishedConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-[32px] bg-white p-8 shadow-2xl">
            <h3 className="mb-4 text-2xl font-bold text-slate-800">Wirklich löschen?</h3>
            <p className="mb-8 text-slate-600">Möchtest du dieses fertige Buch wirklich dauerhaft löschen?</p>
            <div className="flex gap-4">
              <button 
                onClick={() => setShowDeleteFinishedConfirm(null)} 
                className="flex-1 rounded-full bg-slate-100 py-3 font-bold text-slate-700 hover:bg-slate-200 cursor-pointer transition-colors"
              >
                Abbrechen
              </button>
              <button 
                onClick={confirmDeleteFinishedBook} 
                className="flex-[1] bg-red-500 text-white font-bold py-3 rounded-full hover:bg-red-600 transition shadow-[0_4px_0_rgb(153,27,27)] active:translate-y-1 active:shadow-none cursor-pointer"
              >
                Löschen
              </button>
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

                const age = readingBook.zielalter || '4-6 Jahre';
                const layoutType = seite.layoutType || (age === '6-8 Jahre' ? 'stacked' : (idx % 2 === 0 ? 'text-only' : 'image-only'));

                if (layoutType === 'image-only') {
                   return (
                     <div 
                        key={idx} 
                        className="absolute w-full h-[85%] px-0 flex flex-col transition-transform duration-300 ease-in-out"
                        style={{ transform: `translateX(${translatePercent}%)`, opacity: isActive ? 1 : 0.3 }}
                      >
                        <div className="flex-1 bg-slate-900 overflow-hidden relative shadow-2xl rounded-[32px]">
                           {seite.imageUrl ? (
                              <img src={seite.imageUrl} alt={`Seite ${idx + 1}`} className="w-full h-full object-cover" loading="lazy" />
                            ) : (
                               <div className="flex flex-col items-center justify-center h-full w-full bg-slate-100 text-slate-500 p-6 text-center italic">
                                  "{seite.imagePrompt}"
                               </div>
                            )}
                            <p className="absolute bottom-4 right-4 text-xs text-white/50 bg-black/30 px-2 py-1 rounded-full">{idx + 1} / {readingBook.seiten.length}</p>
                        </div>
                      </div>
                   )
                }

                if (layoutType === 'text-only') {
                    return (
                       <div 
                        key={idx} 
                        className="absolute w-full h-[85%] px-4 md:px-8 flex flex-col transition-transform duration-300 ease-in-out"
                        style={{ transform: `translateX(${translatePercent}%)`, opacity: isActive ? 1 : 0.3 }}
                      >
                         <div className="flex-1 bg-[#fdf9f0] text-slate-800 rounded-[32px] p-8 md:p-16 shadow-2xl flex flex-col justify-center items-center relative border border-orange-100/50">
                            {editingPageIdx === idx ? (
                                <>
                                  <textarea 
                                    className="bg-white/50 text-slate-800 p-6 rounded-2xl w-full flex-1 focus:outline-none resize-none text-xl md:text-2xl font-serif text-center"
                                    value={editingText}
                                    onChange={(e) => setEditingText(e.target.value)}
                                  />
                                  <button onClick={() => handleSavePageText(idx)} className="mt-4 bg-emerald-500 text-white px-8 py-3 rounded-full font-bold">Speichern ✓</button>
                                </>
                            ) : (
                                <>
                                   <p className={`font-serif text-center leading-[1.6] text-slate-800 ${seite.text.length < 150 ? 'text-2xl md:text-3xl lg:text-4xl' : (seite.text.length < 250 ? 'text-xl md:text-2xl lg:text-3xl' : 'text-base md:text-lg lg:text-xl')}`}>{seite.text}</p>
                                   <button 
                                      className="absolute top-6 right-6 bg-orange-100 text-orange-600 rounded-full w-10 h-10 flex items-center justify-center hover:bg-orange-200 transition cursor-pointer"
                                      onClick={() => { setEditingPageIdx(idx); setEditingText(seite.text); }}
                                    >
                                      ✏️
                                    </button>
                                </>
                            )}
                            <p className="absolute bottom-6 text-xs text-slate-400 font-bold">{idx + 1} / {readingBook.seiten.length}</p>
                         </div>
                      </div>
                    )
                }

                // Default / Stacked (6-8 Jahre)
                return (
                  <div 
                    key={idx} 
                    className="absolute w-full h-[85%] px-4 md:px-8 flex flex-col transition-transform duration-300 ease-in-out overflow-hidden"
                    style={{ transform: `translateX(${translatePercent}%)`, opacity: isActive ? 1 : 0.3 }}
                  >
                    <div className="flex-[6] bg-white rounded-t-[32px] overflow-hidden flex items-center justify-center relative shadow-md">
                      {seite.imageUrl ? (
                        <img src={seite.imageUrl} alt={`Seite ${idx + 1}`} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                         <div className="bg-slate-100 w-full h-full flex flex-col items-center justify-center p-4 italic text-sm text-slate-400 text-center">"{seite.imagePrompt}"</div>
                      )}
                    </div>
                    <div className="flex-[4] overflow-y-auto bg-slate-800 rounded-b-[32px] p-6 shadow-2xl z-10 border-t-4 border-slate-900 leading-relaxed flex flex-col relative text-white">
                      {editingPageIdx === idx ? (
                        <>
                          <textarea 
                            className="bg-slate-700 text-white p-3 rounded-xl w-full flex-1 focus:outline-none resize-none"
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                          />
                          <button 
                            className="absolute top-4 right-4 bg-emerald-500 text-white rounded-full w-8 h-8 flex items-center justify-center hover:bg-emerald-600 transition cursor-pointer z-20"
                            onClick={() => handleSavePageText(idx)}
                          >
                            ✓
                          </button>
                        </>
                      ) : (
                        <>
                          <p className="text-lg md:text-xl flex-1 pr-6">{seite.text}</p>
                          <button 
                            className="absolute top-4 right-4 bg-slate-700 rounded-full w-8 h-8 flex items-center justify-center text-sm opacity-50 hover:opacity-100 transition cursor-pointer z-20"
                            onClick={() => { setEditingPageIdx(idx); setEditingText(seite.text); }}
                          >
                            ✏️
                          </button>
                        </>
                      )}
                      <p className="text-right text-xs text-slate-500 mt-2">{idx + 1} / {readingBook.seiten.length}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      
      {/* Backup Manager Modal */}
      {isBackupManagerOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-[40px] p-8 w-full max-w-lg shadow-2xl relative">
            <h2 className="text-3xl font-bold text-slate-800 mb-6 flex items-center gap-3">
              ☁️ Backup-Manager
            </h2>
            
            <div className="space-y-6">
              <div className="bg-indigo-50 border border-indigo-100 rounded-[24px] p-6 space-y-4">
                <h3 className="font-bold text-indigo-900 text-lg">Manuelles Backup</h3>
                <div className="flex flex-col sm:flex-row gap-4">
                  <button 
                    onClick={handleDownloadBackup}
                    disabled={isBackupLoading}
                    className="flex-1 bg-white text-indigo-700 py-3 rounded-full font-bold shadow-sm hover:shadow-md transition-all sm:text-sm cursor-pointer disabled:opacity-50"
                  >
                    📥 Als .json exportieren
                  </button>
                  <label className="flex-1 bg-indigo-600 text-white py-3 rounded-full font-bold shadow-sm hover:shadow-md transition-all text-center sm:text-sm cursor-pointer hover:bg-indigo-700 disabled:opacity-50">
                    📤 .json importieren
                    <input 
                      type="file" 
                      accept=".json" 
                      className="hidden" 
                      onChange={handleUploadBackup}
                      disabled={isBackupLoading}
                    />
                  </label>
                </div>
              </div>
              
              <div className="bg-slate-50 border border-slate-100 rounded-[24px] p-6 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-slate-800 text-lg">Automatische Backups</h3>
                  <span className="bg-green-100 text-green-800 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full">Täglich</span>
                </div>
                <p className="text-sm text-slate-500">
                  Die App erstellt jeden Tag beim ersten Start automatisch ein Backup (letzte 7 Tage).
                </p>
                {autoBackups.length > 0 ? (
                  <div className="space-y-2 max-h-[180px] overflow-y-auto pr-2 scrollbar-hide">
                    {autoBackups.map((ab) => (
                      <div key={ab.id || ab.dateString} className="flex justify-between items-center bg-white border border-slate-100 rounded-xl p-3 shadow-sm">
                        <span className="font-bold text-slate-700">{new Date(ab.dateString).toLocaleDateString()}</span>
                        <button 
                          onClick={() => {
                            if(window.confirm("Bist du sicher? Dies fügt die Daten aus dem Backup zu den aktuellen hinzu (Merge). Das Überschreiben überschreibt nicht direkt, sondern fügt fehlende Daten hinzu.")) {
                              handleRestoreAutoBackup(ab);
                            }
                          }}
                          disabled={isBackupLoading}
                          className="bg-emerald-100 text-emerald-800 px-3 py-1.5 rounded-full text-xs font-bold hover:bg-emerald-200 transition-colors disabled:opacity-50 cursor-pointer"
                        >
                          Wiederherstellen
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 italic text-center p-4">Noch keine automatischen Backups vorhanden. Das erste wird heute erstellt!</p>
                )}
              </div>
            </div>
            
            <button 
              onClick={() => setIsBackupManagerOpen(false)}
              className="mt-8 w-full py-4 text-slate-500 font-bold hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
            >
              Schließen
            </button>
            {isBackupLoading && (
              <div className="absolute inset-0 bg-white/50 backdrop-blur-sm rounded-[40px] flex items-center justify-center">
                 <div className="animate-spin text-4xl">⏳</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Label Edit Modal */}
      {isEditingLabels && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-[32px] p-8 w-full max-w-sm shadow-2xl relative">
            <h2 className="text-2xl font-bold text-slate-800 mb-6">Labels anpassen</h2>
            <div className="flex flex-col gap-4">
              {editingCustomLabels.map((l, i) => (
                <div key={l.id} className="flex flex-col gap-1">
                  <div className={`w-full h-2 rounded-t-md ${l.colorClass.split(' ')[0]}`} />
                  <input 
                    type="text" 
                    value={l.name}
                    onChange={(e) => {
                      const newLabels = [...editingCustomLabels];
                      newLabels[i].name = e.target.value;
                      setEditingCustomLabels(newLabels);
                    }}
                    className={`w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-b-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold ${l.colorClass.split(' ')[1]}`}
                    placeholder="Label Name..."
                  />
                </div>
              ))}
            </div>
            <div className="mt-8 flex gap-4">
              <button 
                onClick={() => {
                  setEditingCustomLabels([...customLabels]);
                  setIsEditingLabels(false);
                }}
                className="flex-1 py-3 text-slate-500 font-bold hover:bg-slate-100 rounded-xl transition cursor-pointer"
              >
                Abbrechen
              </button>
              <button 
                onClick={() => {
                  setCustomLabels([...editingCustomLabels]);
                  setIsEditingLabels(false);
                }}
                className="flex-[2] bg-indigo-500 text-white font-bold py-3 rounded-xl hover:bg-indigo-600 transition shadow-sm cursor-pointer"
              >
                Speichern
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Sidebar Navigation */}
      <div 
        className={`fixed inset-0 z-[110] transition-opacity duration-300 md:hidden ${isMobileMenuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setIsMobileMenuOpen(false)} />
        <div 
          className={`absolute top-0 right-0 bottom-0 w-[280px] bg-white shadow-2xl transition-transform duration-300 ease-in-out transform flex flex-col ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-orange-50/50">
            <h2 className="font-bold text-orange-600 text-xl">Menü</h2>
            <button onClick={() => setIsMobileMenuOpen(false)} className="text-slate-500 text-2xl hover:text-slate-800 transition px-2">×</button>
          </div>
          <div className="flex flex-col gap-2 p-4 flex-1 overflow-y-auto">
            <button onClick={() => { setActiveTab('create'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'create' ? 'bg-orange-100 text-orange-700' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
              <span className="text-xl">📖</span> Neue Geschichte
            </button>
            <button onClick={() => { setActiveTab('library'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'library' ? 'bg-orange-100 text-orange-700' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
              <span className="text-xl">📜</span> Meine Kurzskripte <span className="ml-auto bg-white/50 px-2 py-0.5 rounded-full text-xs">{allBooks.length}</span>
            </button>
            <button onClick={() => { setActiveTab('books'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'books' ? 'bg-orange-100 text-orange-700' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
              <span className="text-xl">📚</span> Bücher <span className="ml-auto bg-white/50 px-2 py-0.5 rounded-full text-xs">{allFinishedBooks.length}</span>
            </button>
            
            <div className="h-px bg-slate-100 my-2" />
            
            <button onClick={() => { setIsEditingLabels(true); setIsMobileMenuOpen(false); }} className="p-4 font-bold rounded-2xl flex items-center gap-3 bg-slate-50 text-slate-600 hover:bg-slate-100 transition-colors text-left">
              <span className="text-xl">🏷️</span> Label-Verwaltung
            </button>
            <button onClick={() => { setIsBackupManagerOpen(true); setIsMobileMenuOpen(false); }} className="p-4 font-bold rounded-2xl flex items-center gap-3 bg-slate-50 text-slate-600 hover:bg-slate-100 transition-colors text-left">
              <span className="text-xl">💾</span> Backup-Manager
            </button>
          </div>
          <div className="p-4 border-t border-slate-100">
            <button onClick={() => { signOut(auth); setIsDevMode(false); setIsMobileMenuOpen(false); }} className="w-full rounded-2xl bg-slate-800 px-6 py-4 font-bold text-white shadow-sm cursor-pointer whitespace-nowrap text-center">
              Ausloggen
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}

