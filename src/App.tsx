/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { db, auth, storage } from './lib/firebase';
import { useLanguage } from './LanguageContext';
import { collection, addDoc, serverTimestamp, getDocs, updateDoc, doc, deleteDoc, getDoc, query, where, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';

// --- Initialization ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL_NAME = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-2.5-flash-image';
const ADMIN_EMAIL = 'gbr@jammifashion.de'; 
const ALLOWED_EMAILS = [
  'gbr@jammifashion.de',
  'deine.email@gmail.com',
  'freund@test.de'
].map(e => e.toLowerCase());

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

interface KostenProtokoll {
  entwurf: { tokens_in: number; tokens_out: number; cost: number };
  ausarbeitung: { tokens_in: number; tokens_out: number; cost: number };
  lektorat: { tokens_in: number; tokens_out: number; cost: number };
  bilder: { anzahl: number; cost: number };
  gesamt_kosten_usd: number;
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
  pdfUrl?: string;
  kosten_protokoll?: KostenProtokoll;
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
    hobbys?: string;
    lieblingsessen?: string;
    aengste?: string;
  };
}


export interface Avatar {
  id: string;
  userId: string;
  avatarName: string;
  imageUrl: string;
  characterDescriptionEn: string;
  createdAt: any;
}

export default function App() {
  const { language, setLanguage, t } = useLanguage();
  const [user, setUser] = useState<User | null>(null);
  const [allBooks, setAllBooks] = useState<StoryResult[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'create' | 'library' | 'books'>('dashboard');
  const [isDevMode, setIsDevMode] = useState(false);
  const [idea, setIdea] = useState("");
  const [plushName, setPlushName] = useState("Mein Kuscheltier-Held");
  const [editingHeroId, setEditingHeroId] = useState<string | null>(null);
  const [editingHeroName, setEditingHeroName] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [isGeneratingBook, setIsGeneratingBook] = useState(false);
  const [isInspirationLoading, setIsInspirationLoading] = useState(false);
  const [generationStep, setGenerationStep] = useState<string>('');
  const [result, setResult] = useState<StoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whitelistError, setWhitelistError] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<StoryResult | null>(null);
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | 'selected' | null>(null);
  const [showDeleteFinishedConfirm, setShowDeleteFinishedConfirm] = useState<string | null>(null);
  
  const [savingAvatarRef, setSavingAvatarRef] = useState<StoryResult | AusgearbeitetesBuch | null>(null);
  const [newAvatarName, setNewAvatarName] = useState('');
  const [isAvatarSaving, setIsAvatarSaving] = useState(false);
  
  const [isUploadingPlush, setIsUploadingPlush] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [isBackupManagerOpen, setIsBackupManagerOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [autoBackups, setAutoBackups] = useState<any[]>([]);
  const [isBackupLoading, setIsBackupLoading] = useState(false);
  
  const [allFinishedBooks, setAllFinishedBooks] = useState<AusgearbeitetesBuch[]>([]);
  const [savedAvatars, setSavedAvatars] = useState<Avatar[]>([]);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
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

  // Themes and Dark Mode
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    return localStorage.getItem('jammi_dark_mode') === 'true';
  });
  const [currentTheme, setCurrentTheme] = useState<string>(() => {
    return localStorage.getItem('jammi_theme') || 'orange';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('jammi_dark_mode', isDarkMode.toString());
  }, [isDarkMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('jammi_theme', currentTheme);
  }, [currentTheme]);

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

  const generatePdfBlob = async (book: AusgearbeitetesBuch): Promise<Blob | null> => {
    try {
      const pageWidth = 210;
      const pageHeight = 297;

      const getBase64Image = async (url: string): Promise<string | null> => {
        if (!url) return null;
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          return await new Promise((resolve) => {
             const reader = new FileReader();
             reader.onloadend = () => resolve(reader.result as string);
             reader.readAsDataURL(blob);
          });
        } catch(e) {
             console.warn("Direct fetch fail, using proxy", e);
             const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
             try {
                const res = await fetch(proxyUrl);
                const blob = await res.blob();
                return await new Promise((resolve) => {
                   const reader = new FileReader();
                   reader.onloadend = () => resolve(reader.result as string);
                   reader.readAsDataURL(blob);
                });
             } catch(err) {
                console.warn("Could not load image", url);
                return null;
             }
        }
      };

      // 1. Create a hidden container for the entire book that shares app styles
      const container = document.createElement('div');
      container.style.width = '794px';
      container.style.position = 'absolute';
      container.style.left = '-9999px';
      container.style.top = '0px';
      container.style.backgroundColor = '#FFFDF2';
      container.style.color = '#1e293b';
      container.className = "font-sans";
      document.body.appendChild(container);

      // Render cover
      const coverDiv = document.createElement('div');
      coverDiv.style.width = '794px';
      coverDiv.style.height = '1123px';
      coverDiv.style.backgroundColor = '#FFFDF2';
      coverDiv.className = "flex flex-col items-center justify-center p-16 box-border gap-12 relative";
      
      const coverImgB64 = await getBase64Image(book.coverImage || '');
      
      coverDiv.innerHTML = `
          <h1 class="text-6xl font-magic text-center leading-tight drop-shadow-sm" style="color: var(--color-theme-title);">${book.titel}</h1>
          ${coverImgB64 ? `<div class="w-96 h-96 rounded-full overflow-hidden border-8 shadow-xl" style="border-color: #ffffff; background-color: var(--color-theme-bg-softer);"><div style="width: 100%; height: 100%; background-image: url('${coverImgB64}'); background-size: cover; background-position: center;"></div></div>` : ''}
          <div class="flex gap-4 mt-8">
            <span class="text-xl font-bold px-6 py-2 rounded-full shadow-sm" style="background-color: #e0e7ff; color: #3730a3;">${book.zielalter}</span>
            <span class="text-xl font-bold px-6 py-2 rounded-full shadow-sm" style="background-color: #fce7f3; color: #9d174d;">${book.stimmung}</span>
          </div>
      `;
      container.appendChild(coverDiv);

      const pageDivs: HTMLElement[] = [];

      for (let i = 0; i < book.seiten.length; i++) {
          const page = book.seiten[i];
          const pageDiv = document.createElement('div');
          pageDiv.style.width = '794px';
          pageDiv.style.height = '1123px';
          pageDiv.style.backgroundColor = '#FFFDF2';
          pageDiv.className = "flex flex-col p-12 box-border relative";

          const pageImgB64 = await getBase64Image(page.imageUrl || '');
          
          const age = book.zielalter || '4-6 Jahre';
          const layoutType = page.layoutType || (age === '6-8 Jahre' ? 'stacked' : (i % 2 === 0 ? 'text-only' : 'image-only'));

          // Replicate layout from Reader Modal!
          const fontSizeClass = page.text.length < 150 ? 'text-5xl' : (page.text.length < 250 ? 'text-4xl' : 'text-2xl');

          if (layoutType === 'image-only') {
              pageDiv.innerHTML = `
                <div class="flex-1 rounded-2xl overflow-hidden relative shadow-inner" style="background-color: #f1f5f9;">
                    ${pageImgB64 ? `<div style="width: 100%; height: 100%; position: absolute; top: 0; left: 0; background-image: url('${pageImgB64}'); background-size: cover; background-position: center;"></div>` : ''}
                </div>
                <p class="absolute bottom-6 right-12 text-lg font-bold" style="color: #94a3b8;">${i + 1} / ${book.seiten.length}</p>
              `;
          } else if (layoutType === 'text-only') {
              pageDiv.innerHTML = `
                <div class="flex-1 flex items-center justify-center p-16">
                    <p class="font-serif text-center leading-[1.6] ${fontSizeClass}" style="color: #1e293b;">${page.text.replace(/\n/g, '<br/>')}</p>
                </div>
                <p class="absolute bottom-6 right-12 text-lg font-bold" style="color: #94a3b8;">${i + 1} / ${book.seiten.length}</p>
              `;
          } else {
              pageDiv.innerHTML = `
                <div class="flex-1 flex flex-col gap-8 pb-12">
                    <div class="w-full h-[500px] rounded-2xl overflow-hidden relative shadow-inner shrink-0" style="background-color: #f1f5f9;">
                      ${pageImgB64 ? `<div style="width: 100%; height: 100%; position: absolute; top: 0; left: 0; background-image: url('${pageImgB64}'); background-size: cover; background-position: center;"></div>` : ''}
                    </div>
                    <div class="flex-1 flex items-center justify-center px-8">
                      <p class="font-serif text-center leading-[1.6] ${fontSizeClass}" style="color: #1e293b;">${page.text.replace(/\n/g, '<br/>')}</p>
                    </div>
                </div>
                <p class="absolute bottom-6 right-12 text-lg font-bold" style="color: #94a3b8;">${i + 1} / ${book.seiten.length}</p>
              `;
          }

          container.appendChild(pageDiv);
          pageDivs.push(pageDiv);
      }

      // Allow DOM to settle and fonts to apply
      await new Promise(r => setTimeout(r, 500));
      
      const pdfDoc = new jsPDF({
          orientation: 'portrait',
          unit: 'mm',
          format: 'a4'
      });

      const coverCanvas = await html2canvas(coverDiv, { scale: 2, useCORS: true, backgroundColor: 'var(--color-theme-bg)', logging: false });
      pdfDoc.addImage(coverCanvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297);

      for (let i = 0; i < pageDivs.length; i++) {
          pdfDoc.addPage();
          const pageCanvas = await html2canvas(pageDivs[i], { scale: 2, useCORS: true, backgroundColor: 'var(--color-theme-bg)', logging: false });
          pdfDoc.addImage(pageCanvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297);
      }

      document.body.removeChild(container);
      return pdfDoc.output('blob');
    } catch (err) {
      console.error("Fehler beim Erzeugen des PDF Blobs:", err);
      return null;
    }
  };

  const handleDownloadPDF = async (book: AusgearbeitetesBuch) => {
    setIsLoading(true);
    try {
      const blob = await generatePdfBlob(book);
      if (!blob) throw new Error("Konnte PDF nicht erzeugen");
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${book.titel.replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Fehler beim PDF Export:", err);
      alert("Fehler beim PDF Export: " + (err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const generateAndUploadPdf = async (book: AusgearbeitetesBuch): Promise<string | null> => {
    try {
      console.log("Starte automatischen PDF Upload für:", book.titel);
      const blob = await generatePdfBlob(book);
      if (!blob) return null;

      const storageRef = ref(storage, `buecher_pdfs/${book.id}.pdf`);
      await uploadBytes(storageRef, blob);
      const url = await getDownloadURL(storageRef);
      await updateDoc(doc(db, 'ausgearbeitete_buecher', book.id), { pdfUrl: url });
      console.log("PDF erfolgreich in Storage hochgeladen:", url);
      return url;
    } catch (err) {
      console.error("Upload des PDFs in Storage fehlgeschlagen:", err);
      return null;
    }
  };

  const Dashboard = () => {
    const [liveSpend, setLiveSpend] = useState<number | null>(null);
    const [isLoadingStats, setIsLoadingStats] = useState(false);

    async function fetchBilling() {
        setIsLoadingStats(true);
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
        } finally {
            setIsLoadingStats(false);
        }
    }

    return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6">
        <button onClick={() => setActiveTab('create')} className="bg-theme-card p-8 rounded-[32px] shadow-sm border border-theme-border hover:border-theme-primary-border transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">✍️</span>
          <span className="font-bold text-xl text-theme-base">{t('dashboard.new_story')}</span>
        </button>
        <button onClick={() => setActiveTab('avatars')} className="bg-theme-card p-8 rounded-[32px] shadow-sm border border-theme-border hover:border-theme-primary-border transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">🦸</span>
          <span className="font-bold text-xl text-theme-base">Helden-Galerie</span>
        </button>
        <button onClick={() => setActiveTab('library')} className="bg-theme-card p-8 rounded-[32px] shadow-sm border border-theme-border hover:border-theme-primary-border transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">📜</span>
          <span className="font-bold text-xl text-theme-base">{t('dashboard.my_scripts')} ({allBooks.length})</span>
        </button>
        <button onClick={() => setActiveTab('books')} className="bg-theme-card p-8 rounded-[32px] shadow-sm border border-theme-border hover:border-theme-primary-border transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">📚</span>
          <span className="font-bold text-xl text-theme-base">{t('dashboard.my_books')} ({allFinishedBooks.length})</span>
        </button>
        <button onClick={() => setIsBackupManagerOpen(true)} className="bg-theme-card p-8 rounded-[32px] shadow-sm border border-theme-border hover:border-theme-primary-border transition-all flex flex-col items-center gap-4 text-center cursor-pointer">
          <span className="text-5xl">💾</span>
          <span className="font-bold text-xl text-theme-base">{t('dashboard.backup_manager')}</span>
        </button>
      </div>

      <div className="bg-theme-card p-6 rounded-3xl border border-theme-border flex items-center justify-between shadow-sm">
        <div className="text-sm font-bold text-theme-muted-light uppercase tracking-widest">{t('dashboard.cost_overview')} {liveSpend !== null ? t('dashboard.live') : t('dashboard.estimated')}</div>
        <div className="flex items-center gap-4">
            {liveSpend === null && (
                <button onClick={fetchBilling} disabled={isLoadingStats} className="text-xs text-theme-primary font-bold hover:underline cursor-pointer">
                    {isLoadingStats ? t('common.loading') : t('dashboard.fetch_costs')}
                </button>
            )}
            <div className="font-bold text-theme-base">{liveSpend !== null ? `$${liveSpend.toFixed(2)}` : `$${stats.total.toFixed(2)}`}</div>
        </div>
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
    return onAuthStateChanged(auth, async (authUser) => {
      if (authUser && authUser.email) {
        const email = authUser.email.toLowerCase();
        if (!ALLOWED_EMAILS.includes(email)) {
          await signOut(auth);
          setWhitelistError(t('common.whitelist_denied'));
          setUser(null);
          return;
        }
      }
      
      setUser(authUser);
      setWhitelistError(null);
      if (authUser) {
        fetchBooks();
        fetchFinishedBooks();
        fetchAvatars(authUser.uid);
        if (authUser.email === ADMIN_EMAIL) {
          checkAndCreateAutoBackup();
        }
      }
    });
  }, [t]);

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

  const fetchAvatars = async (uid: string) => {
    try {
      // In development mode, we might be pretending to be dev-user, but wait: isDevMode handles currentUser, let's use the effective uid
      const effectiveUid = isDevMode ? 'dev-user' : uid;
      const q = query(collection(db, 'avatars'), where('userId', '==', effectiveUid));
      const querySnapshot = await getDocs(q);
      const avatars = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Avatar));
      setSavedAvatars(avatars.sort((a,b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
    } catch (err) {
      console.error("Error fetching avatars:", err);
    }
  };

  const handlePlushUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsUploadingPlush(true);
    setUploadError(null);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result?.toString().split(',')[1];
        if (!base64Data) {
          setUploadError("Fehler beim Lesen des Bildes.");
          setIsUploadingPlush(false);
          return;
        }

        try {
          const token = await auth.currentUser?.getIdToken();
          const res = await fetch('/api/verzaubern', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ imageBase64: base64Data })
          });
          
          console.log("[Verzaubern] Response Status:", res.status, res.statusText);
          const responseText = await res.text();
          console.log("[Verzaubern] Response Text:", responseText.substring(0, 500));
          
          if (!res.ok) {
             let errorMsg = "Unerwarteter Fehler: " + res.status;
             try {
               const parsed = JSON.parse(responseText);
               if (parsed.error) errorMsg = parsed.error;
             } catch (e) {
               console.warn("Could not parse error response as JSON", e);
             }
             throw new Error(errorMsg);
          }
          
          const data = JSON.parse(responseText);

          // Save to firestore
          await addDoc(collection(db, 'avatars'), {
            userId: isDevMode ? 'dev-user' : currentUser?.uid,
            avatarName: plushName.trim() || 'Mein Kuscheltier-Held',
            imageUrl: data.avatar_url,
            characterDescriptionEn: data.prompt_en,
            createdAt: serverTimestamp()
          });

          fetchAvatars(isDevMode ? 'dev-user' : currentUser?.uid || '');
        } catch (err: any) {
          setUploadError(err.message);
        } finally {
          setIsUploadingPlush(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setUploadError(err.message);
      setIsUploadingPlush(false);
    }
  };

  const handleSaveAvatar = async () => {
    if (!savingAvatarRef || !newAvatarName.trim() || !currentUser) return;
    setIsAvatarSaving(true);
    try {
      const chara = savingAvatarRef.hauptcharakter;
      if (!chara || !chara.avatar_url) return;
      const docRef = await addDoc(collection(db, 'avatars'), {
        userId: isDevMode ? 'dev-user' : currentUser.uid,
        avatarName: newAvatarName.trim(),
        imageUrl: chara.avatar_url,
        characterDescriptionEn: chara.bild_prompt_en,
        createdAt: serverTimestamp()
      });
      // reload avatars
      fetchAvatars(isDevMode ? 'dev-user' : currentUser.uid);
      setSavingAvatarRef(null);
      setNewAvatarName('');
    } catch(err) {
      handleFirestoreError(err, OperationType.CREATE, 'avatars');
    } finally {
      setIsAvatarSaving(false);
    }
  };

  const handleDeleteAvatar = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'avatars', id));
      setSavedAvatars(prev => prev.filter(a => a.id !== id));
      if (selectedAvatarId === id) setSelectedAvatarId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `avatars/${id}`);
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
    fetchBooks();
    fetchFinishedBooks();
    fetchAvatars('dev-user');
  };

  const currentUser = isDevMode ? { email: ADMIN_EMAIL, uid: 'dev-user' } : user;

  if (!currentUser) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-theme-bg p-4 text-center">
        <div className="flex gap-4 mb-4 flex-wrap justify-center">
          <div className="flex gap-2 p-1 bg-theme-card rounded-full shadow-sm border border-theme-border">
            <button 
              onClick={() => setLanguage('de')} 
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-all ${language === 'de' ? 'bg-theme-primary-soft scale-110 shadow-inner' : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100'}`}
              title="Deutsch"
            >
              🇩🇪
            </button>
            <button 
              onClick={() => setLanguage('en')} 
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-all ${language === 'en' ? 'bg-theme-primary-soft scale-110 shadow-inner' : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100'}`}
              title="English"
            >
              EN
            </button>
          </div>
          
          {/* Dark Mode and Theme Switcher */}
          <div className="flex gap-1 p-1 bg-theme-card rounded-full shadow-sm border border-theme-border flex-wrap justify-center items-center">
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="w-10 h-10 flex items-center justify-center rounded-full transition-all hover:bg-theme-bg-soft"
              title="Dunkelmodus"
            >
              <span className="text-xl">{isDarkMode ? '🌙' : '☀️'}</span>
            </button>
            <div className="w-px h-8 bg-theme-border my-auto mx-2"></div>
            <button
              onClick={() => setCurrentTheme('orange')}
              className={`w-8 h-8 m-1 rounded-full border-2 transition-all ${currentTheme === 'orange' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-orange-500`}
              title="Farbthema: Orange"
            ></button>
            <button
              onClick={() => setCurrentTheme('mint')}
              className={`w-8 h-8 m-1 rounded-full border-2 transition-all ${currentTheme === 'mint' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-emerald-500`}
              title="Farbthema: Minze"
            ></button>
            <button
              onClick={() => setCurrentTheme('ocean')}
              className={`w-8 h-8 m-1 rounded-full border-2 transition-all ${currentTheme === 'ocean' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-blue-500`}
              title="Farbthema: Ozean"
            ></button>
            <button
              onClick={() => setCurrentTheme('berry')}
              className={`w-8 h-8 m-1 rounded-full border-2 transition-all ${currentTheme === 'berry' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-purple-500`}
              title="Farbthema: Beere"
            ></button>
          </div>
        </div>
        <div className="mb-8 flex flex-col items-center animate-in fade-in zoom-in duration-1000">
          <div className="w-24 h-24 bg-theme-card rounded-[32px] shadow-xl flex items-center justify-center text-5xl mb-6 border-4 border-theme-primary-softer">📖</div>
          <h1 className="text-6xl font-magic text-theme-title mb-2 drop-shadow-sm">{t('common.app_name')}</h1>
          <p className="text-theme-muted font-medium tracking-wide border-t border-theme-border pt-2 px-4 uppercase text-[10px]">{t('common.tagline')}</p>
        </div>

        {whitelistError && (
          <div className="mb-6 p-4 max-w-xs bg-theme-card border border-theme-primary-border rounded-3xl text-theme-primary-strong text-sm font-bold shadow-sm animate-in slide-in-from-top-4 duration-300">
            {whitelistError}
          </div>
        )}

        <button onClick={handleLogin} className="w-full max-w-xs rounded-full bg-theme-primary px-8 py-5 text-xl font-bold text-white shadow-[0_8px_0_rgb(194,65,12)] hover:-translate-y-1 hover:shadow-[0_10px_0_rgb(194,65,12)] active:translate-y-1 active:shadow-none transition-all cursor-pointer">
          {t('common.login')}
        </button>
        <p className="text-[10px] text-stone-400 text-center max-w-sm mt-8 leading-relaxed">
          {t('common.login_hint')}
        </p>
      </div>
    );
  }

  if (currentUser.email && !ALLOWED_EMAILS.includes(currentUser.email.toLowerCase())) {
    return (
      <div className="flex h-screen items-center justify-center bg-theme-bg p-6 text-center">
        <div className="rounded-[40px] bg-theme-card p-10 shadow-xl">
          <h1 className="text-3xl font-bold text-theme-primary">{t('common.access_denied')}</h1>
          <p className="mt-4 text-theme-muted">{whitelistError || t('common.no_permission')}</p>
          <button onClick={() => { signOut(auth); setIsDevMode(false); setWhitelistError(null); }} className="mt-6 rounded-full bg-theme-bg-mute px-6 py-2">{t('common.logout')}</button>
        </div>
      </div>
    );
  }

  // --- Translation Helper ---
  const getTranslatedLabel = (key: 'zielalter' | 'stimmung', value: string) => {
      if (key === 'zielalter') {
          if (value === '2-4 Jahre' || value === '2-4 Years') return t('create.age_2_4');
          if (value === '4-6 Jahre' || value === '4-6 Years') return t('create.age_4_6');
          if (value === '6-8 Jahre' || value === '6-8 Years') return t('create.age_6_8');
      }
      if (key === 'stimmung') {
          if (value === 'Lustig' || value === 'Funny') return t('create.mood_funny');
          if (value === 'Träumerisch' || value === 'Dreamy') return t('create.mood_dreamy');
          if (value === 'Lehrreich' || value === 'Educational') return t('create.mood_educational');
          if (value === 'Spannend' || value === 'Exciting') return t('create.mood_exciting');
      }
      return value;
  };

  // --- Handlers ---
  const handleGenerateInspiration = async () => {
    setIsInspirationLoading(true);
    try {
      const prompt = idea.trim().length > 0
        ? `Note these keywords: '${idea}'. Based on them, build a single, extremely engaging, magical and child-friendly starting point (max 1-2 sentences) for a children's book. The tone should be warm, inviting and creative. Return ONLY the finished proposal text, no other text around it. IMPORTANT: GENERATE THE TEXT IN ${language.toUpperCase()}.`
        : `Generate a completely random, beautiful and creative starting point (1-2 sentences) for a children's book. Use themes like brave animals, vibrant nature, friendly robots, space adventures or magical worlds. Return ONLY the finished proposal text, no other text around it. IMPORTANT: GENERATE THE TEXT IN ${language.toUpperCase()}.`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: { parts: [{ text: prompt }] },
      });

      if (response.text) {
        setIdea(response.text.trim());
      }
    } catch (err) {
      console.error("Error in inspiration:", err);
      setError(t('create.inspiration_error'));
    } finally {
      setIsInspirationLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!idea.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      // 0. LOCAL KEYWORD PRE-CHECK
      const blockedKeywords = ['tod', 'blut', 'mord', 'töten', 'krieg', 'gewalt', 'sex', 'porno', 'droge', 'waffe', 'schießen', 'sterben', 'schlagen', 'hassen', 'death', 'blood', 'murder', 'kill', 'war', 'violence', 'porn', 'drug', 'weapon', 'shoot', 'die', 'hit', 'hate'];
      const ideaLower = idea.toLowerCase();
      const hasBlockedWord = blockedKeywords.some(word => ideaLower.includes(word));
      
      if (hasBlockedWord) {
        setError(t('create.safety_error'));
        setIsLoading(false);
        return;
      }

      // 1. AI PRE-CHECK
      const safetyPrompt = `Evaluate the following input strictly for child safety. Does it contain sensitive, violent, frightening, drug-related, discriminatory or sexual content? Reply ONLY with "UNSAFE" if it is inappropriate, otherwise with "SAFE". Language may vary.\nInput: "${idea}"`;
      const safetyRes = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: safetyPrompt,
        config: {
          systemInstruction: "You are a strict youth protection filter for children aged 2 to 8 years."
        }
      });
      if (safetyRes.text && safetyRes.text.trim().toUpperCase().includes('UNSAFE')) {
        setError(t('create.safety_error'));
        setIsLoading(false);
        return;
      }

      let heroInstruction = `ABOUT THE MAIN CHARACTER: The 'bild_prompt_en' MUST be a 'Complete Outfit Blueprint'. Define ALL pieces of clothing (headwear, top, bottom, shoes, accessories) with fixed colors and styles. Anything not explicitly defined leads to inconsistencies.`;
      
      const selectedAvatar = savedAvatars.find(a => a.id === selectedAvatarId);
      if (selectedAvatar) {
        heroInstruction = `ABOUT THE MAIN CHARACTER: YOU MUST USE EXACTLY THIS ALREADY EXISTING CHARACTER AND DO NOT INVENT A NEW ONE! 
        - name: "${selectedAvatar.avatarName}"
        - bild_prompt_en MUST BE EXACTLY: "${selectedAvatar.characterDescriptionEn}"
        Modify the gattung, persoenlichkeit and aussehen_de to broadly match this character, but keep the name and bild_prompt_en EXACTLY as provided above!`;
      }

      const prompt = `Create a children's book concept based on the idea: "${idea}". The response MUST be a valid JSON object matching this exact structure (no markdown, no extra characters). 
      IMPORTANT: All fields (titles, storyline, character description) EXCEPT 'bild_prompt_en' MUST be in ${language.toUpperCase()}. 
      'bild_prompt_en' MUST ALWAYS BE IN ENGLISH.
      
      ${heroInstruction}
      
      {
        "titel_optionen": ["...", "...", "..."],
        "zielgruppe": "...",
        "storyline": { "anfang": "...", "mitte": "...", "ende": "..." },
        "story_skelett": { "kapitel_1": "...", "kapitel_2": "...", "kapitel_3": "...", "kapitel_4": "...", "kapitel_5": "..." },
        "hauptcharakter": { "name": "...", "gattung": "...", "persoenlichkeit": "...", "hobbys": "...", "lieblingsessen": "...", "aengste": "...", "aussehen_de": "...", "bild_prompt_en": "Example: 'A cute, small baby bear, wearing a bright yellow short-sleeve t-shirt under classic dark blue denim dungarees, a red baseball cap, and tiny white sneakers. Big friendly eyes, cartoon illustration style, vibrant Pixar colors, clean white background, 3d render style.'" }
      }`;
      
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: `IRREVERSIBLE RULE: Only youth-friendly, positive and educationally valuable content for children between 2 and 8 years of age may be generated. Targeted language: ${language.toUpperCase()}.`
        }
      });

      // We will track cost after saving to firestore
      const text = response.text || '';
      const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
      const storyData: StoryResult = JSON.parse(cleanJson);
      
      if (selectedAvatar) {
        storyData.hauptcharakter.name = selectedAvatar.avatarName;
        storyData.hauptcharakter.bild_prompt_en = selectedAvatar.characterDescriptionEn;
        storyData.hauptcharakter.avatar_url = selectedAvatar.imageUrl;
      }

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
        
        const metrics = await updateBookCosts(bookId, {
          promptTokens: response.usageMetadata?.promptTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount
        });

        setResult({ 
          ...storyData, 
          id: bookId,
          cost_metrics: metrics || {
            text_input_tokens: response.usageMetadata?.promptTokenCount || 0,
            text_output_tokens: response.usageMetadata?.candidatesTokenCount || 0,
            images_generated: 0,
            total_cost_usd: 0
          }
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

  const generatePageImage = async (bookId: string, pageIndex: number, prompt: string) => {
    setIsImageLoading(true);
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
      if (!apiKey) throw new Error("Gemini API Key fehlt!");
      const aiPaid = new GoogleGenAI({ apiKey });

      const finalPrompt = prompt + ", absolutely no text, no letters, no words, no typography, no signatures, clean character digital art style, perfect illustration";

      const response = await aiPaid.models.generateContent({
        model: IMAGE_MODEL,
        contents: { parts: [{ text: finalPrompt }] },
        config: { imageConfig: { aspectRatio: "1:1" } }
      });

      let base64Image = '';
      if (response && response.candidates && response.candidates[0].content.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) { base64Image = part.inlineData.data; break; }
        }
      }
      if (!base64Image) throw new Error("Bild-Antwort der API war leer.");

      // 5. Speicher in Firebase Storage
      const storageRef = ref(storage, `buecher/${bookId}/page_${pageIndex}_${Date.now()}.png`);
      const blob = await fetch(`data:image/png;base64,${base64Image}`).then(r => r.blob());
      await uploadBytes(storageRef, blob);
      const url = await getDownloadURL(storageRef);

      return url;
    } catch (err: any) {
      console.error("Bildgenerierung Fehler:", err);
      return null;
    } finally {
      setIsImageLoading(false);
    }
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
        console.error("[Frontend] API Fehler:", apiErr);
        throw new Error(`API Fehler: ${apiErr.message}`);
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
      return newMetrics;
    } catch (e) {
      console.warn("Could not update cost", e);
      return null;
    }
  };

  const handleGenerateBook = async () => {
    if (!selectedSkriptForBook) return;
    setIsGeneratingBook(true);
    setGenerationStep(t('create.writing_step'));
    setError(null);
    try {
      const count = (selectedSkriptForBook.erzeugteBuecherCount || 0);
      if (count >= 3) {
          throw new Error(t('create.limit_reached'));
      }
      
      const { zielalter, stimmung, seitenAnzahl } = bookConfig;
      let inhaltsdichte = "Medium";
      if (language === 'de') {
        if (zielalter === "2-4 Jahre") inhaltsdichte = "Klein (Sehr einfache, kurze Sätze, ca. 1-2 Sätze pro Seite)";
        else if (zielalter === "4-6 Jahre") inhaltsdichte = "Mittel (Einfache Sätze, ca. 3-4 Sätze pro Seite)";
        else if (zielalter === "6-8 Jahre") inhaltsdichte = "Groß (Längere Sätze, somewhat komplexere Struktur, ca. 4-6 Sätze pro Seite)";
      } else {
        if (zielalter === "2-4 Jahre") inhaltsdichte = "Low (Very simple, short sentences, approx. 1-2 sentences per page)";
        else if (zielalter === "4-6 Jahre") inhaltsdichte = "Medium (Simple sentences, approx. 3-4 sentences per page)";
        else if (zielalter === "6-8 Jahre") inhaltsdichte = "High (Longer sentences, somewhat more complex structure, approx. 4-6 sentences per page)";
      }

      const promptStr = `
You are a professional children's book author. Turn the following short script into a complete book, formatted as JSON.
TARGET LANGUAGE: ${language.toUpperCase()}

The parameters:
Target Age: ${zielalter}
Mood: ${stimmung}
Pages: ${seitenAnzahl}
Content Density: ${inhaltsdichte}

Character: ${JSON.stringify(selectedSkriptForBook.hauptcharakter)}
Storyline: ${JSON.stringify(selectedSkriptForBook.storyline)}

LAYOUT RULES:
- For age groups "2-4 Jahre" and "4-6 Jahre": Strictly separate image and text on different pages (layoutType "text-only" or "image-only").
  The book MUST alternate between text and image pages (Page 1: Text, Page 2: Image, Page 3: Text...).
  For text pages: Increase narrative depth. The 'imagePrompt' field remains empty ("").
  For image pages: The 'text' field remains empty (""). Generate a high-quality 'imagePrompt'.
- For age group "6-8 Jahre": Use layoutType "stacked". Here, image AND text are on EVERY page (image top, text bottom).

VISUAL CONSISTENCY:
- Analyze for each image request separately whether the main character MUST appear.
- ALWAYS GENERATE 'imagePrompt' IN ENGLISH. 
- APPEND THIS ANTI-TEXT BAR TO EVERY imagePrompt: ", absolutely no text, no letters, no words, no typography, no signatures, clean character digital art style, perfect illustration"

Your output MUST have exactly this JSON format:
{
  "titel": "Creative book title in ${language.toUpperCase()}",
  "seiten": [
    {
      "pageNumber": 1,
      "layoutType": "text-only", 
      "text": "Text for this page in ${language.toUpperCase()}...",
      "imagePrompt": ""
    }
    // ... exactly ${seitenAnzahl} pages
  ]
}
`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: {
          parts: [{ text: promptStr }],
        },
        config: {
          responseMimeType: "application/json",
          systemInstruction: `IRREVERSIBLE RULE: Only youth-friendly, positive and educationally valuable content for children between 2 and 8 years of age may be generated. Language: ${language.toUpperCase()}.`
        }
      });
      
      const ausarbeitungTokensIn = response.usageMetadata?.promptTokenCount || 0;
      const ausarbeitungTokensOut = response.usageMetadata?.candidatesTokenCount || 0;

      await updateBookCosts(selectedSkriptForBook.id, {
        promptTokens: ausarbeitungTokensIn,
        outputTokens: ausarbeitungTokensOut
      });

      let txt = response.text || "{}";
      const cleanJson = txt.replace(/```json\n?|\n?```/g, '').trim();

      // --- LEKTORAT (Gemini Pro) ---
      setGenerationStep(t('create.polishing_step'));
      
      const lektoratPromptStr = `Here is the raw draft book JSON:\n\n${cleanJson}\n\nReturn strictly a valid JSON object in the exact same format! Ensure the language is ${language.toUpperCase()}.`;
      const lektoratRes = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview', // Updated to latest Pro model
        contents: {
          parts: [{ text: lektoratPromptStr }]
        },
        config: {
          responseMimeType: "application/json",
          systemInstruction: `You are a professional children's book editor. Your task is to stylistically, grammatically and educationally polish the existing book JSON in ${language.toUpperCase()}. Optimize the text smoothly for the target group ${zielalter}, correct sentence structures and make the choice of words even more magical. Never change the JSON structure, the number of pages or the fields (especially 'pageNumber', 'layoutType', 'imagePrompt'). RETURN EXCLUSIVELY THE CORRECTED JSON.`
        }
      });

      const lektoratTokensIn = lektoratRes.usageMetadata?.promptTokenCount || 0;
      const lektoratTokensOut = lektoratRes.usageMetadata?.candidatesTokenCount || 0;

      let lektoratTxt = lektoratRes.text || cleanJson;
      const finalJsonStr = lektoratTxt.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(finalJsonStr);
      let pages = (parsed.seiten || []) as BookPage[];

      // --- KOSTENBERECHNUNG ---
      const entwurfIn = selectedSkriptForBook.cost_metrics?.text_input_tokens || 0;
      const entwurfOut = selectedSkriptForBook.cost_metrics?.text_output_tokens || 0;
      const entwurfCost = (entwurfIn / 1_000_000 * 0.075) + (entwurfOut / 1_000_000 * 0.30);
      
      const ausarbeitungCost = (ausarbeitungTokensIn / 1_000_000 * 0.075) + (ausarbeitungTokensOut / 1_000_000 * 0.30);
      const lektoratCost = (lektoratTokensIn / 1_000_000 * 1.25) + (lektoratTokensOut / 1_000_000 * 5.00);
      
      let kostenProtokoll: KostenProtokoll = {
        entwurf: { tokens_in: entwurfIn, tokens_out: entwurfOut, cost: entwurfCost },
        ausarbeitung: { tokens_in: ausarbeitungTokensIn, tokens_out: ausarbeitungTokensOut, cost: ausarbeitungCost },
        lektorat: { tokens_in: lektoratTokensIn, tokens_out: lektoratTokensOut, cost: lektoratCost },
        bilder: { anzahl: 0, cost: 0 },
        gesamt_kosten_usd: entwurfCost + ausarbeitungCost + lektoratCost
      };

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
        created_at: serverTimestamp(),
        kosten_protokoll: kostenProtokoll
      };
      
      const docRef = await addDoc(collection(db, 'ausgearbeitete_buecher'), newBookData);
      
      // --- IMAGE GENERATION ---
      const maxImages = seitenAnzahl <= 12 ? 6 : 8;
      let generatedCount = 0;
      let pagesWithImages = pages.filter(p => p.layoutType === 'image-only' || p.layoutType === 'stacked');
      
      // Budget clamp
      for(let i = 0; i < pagesWithImages.length; i++) {
          if (generatedCount >= maxImages) {
              pagesWithImages[i].layoutType = 'text-only';
              pagesWithImages[i].imagePrompt = '';
              continue;
          }
          
          setGenerationStep(`Generiere Bild ${generatedCount + 1} von ${Math.min(pagesWithImages.length, maxImages)}... 🎨`);
          
          const fullPrompt = `${selectedSkriptForBook.hauptcharakter.bild_prompt_en}, ${pagesWithImages[i].imagePrompt}`;
          const url = await generatePageImage(docRef.id, pagesWithImages[i].pageNumber, fullPrompt);                
          
          if (url) {
              pagesWithImages[i].imageUrl = url;
              generatedCount++;
              
              kostenProtokoll.bilder.anzahl = generatedCount;
              kostenProtokoll.bilder.cost = generatedCount * 0.03;
              kostenProtokoll.gesamt_kosten_usd = entwurfCost + ausarbeitungCost + lektoratCost + kostenProtokoll.bilder.cost;

              await updateBookCosts(selectedSkriptForBook.id, { imageGenerated: true });
          } else {
              // Bei Fehler zur Sicherheit als Nur-Text anzeigen, falls kein Bild generiert werden konnte
              pagesWithImages[i].layoutType = 'text-only';
          }
          
          // Firestore Update nach Änderungen an dieser Seite, damit alle Anpassungen persistiert werden
          await updateDoc(doc(db, 'ausgearbeitete_buecher', docRef.id), { 
              seiten: pages,
              kosten_protokoll: kostenProtokoll
          });
      }

      // Falls es durch den continue Block am Ende ungeupdatete Seiten gab, einmal final speichern:
      await updateDoc(doc(db, 'ausgearbeitete_buecher', docRef.id), { seiten: pages, kosten_protokoll: kostenProtokoll });

      const newCount = count + 1;
      await updateDoc(doc(db, 'buecher', selectedSkriptForBook.id), { erzeugteBuecherCount: newCount });

      const finalizedBook = { id: docRef.id, ...newBookData, seiten: pages, kosten_protokoll: kostenProtokoll } as AusgearbeitetesBuch;
      
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
    <div className="min-h-screen bg-theme-bg p-4 sm:p-6 font-sans text-theme-base w-full max-w-full overflow-x-hidden relative">
      <header className="mb-6 sm:mb-12 flex flex-col items-center justify-center mt-2 sm:mt-4 relative z-40 bg-theme-bg gap-4">
        <div className="flex flex-col md:flex-row items-center gap-4">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-magic tracking-normal text-theme-primary drop-shadow-[0_2px_2px_rgba(249,115,22,0.2)] text-center">
            {t('common.slogan')}
          </h1>
          
          {/* Language Switcher in Header */}
          <div className="flex gap-2 p-1 bg-theme-card rounded-full shadow-sm border border-theme-primary-softer">
            <button 
              onClick={() => setLanguage('de')} 
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-all text-xs ${language === 'de' ? 'bg-theme-primary-soft shadow-inner' : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100'}`}
              title="Deutsch"
            >
              🇩🇪
            </button>
            <button 
              onClick={() => setLanguage('en')} 
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-all text-xs ${language === 'en' ? 'bg-theme-primary-soft shadow-inner' : 'grayscale opacity-50 hover:grayscale-0 hover:opacity-100'}`}
              title="English"
            >
              EN
            </button>
          </div>
          
          {/* Dark Mode and Theme Switcher */}
          <div className="flex gap-1 p-1 bg-theme-card rounded-full shadow-sm border border-theme-border flex-wrap justify-center">
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="w-8 h-8 flex items-center justify-center rounded-full transition-all text-sm hover:bg-theme-bg-soft"
              title="Dunkelmodus"
            >
              {isDarkMode ? '🌙' : '☀️'}
            </button>
            <div className="w-px h-6 bg-theme-border my-auto mx-1"></div>
            <button
              onClick={() => setCurrentTheme('orange')}
              className={`w-6 h-6 m-1 rounded-full border-2 transition-all ${currentTheme === 'orange' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-orange-500`}
              title="Farbthema: Orange"
            ></button>
            <button
              onClick={() => setCurrentTheme('mint')}
              className={`w-6 h-6 m-1 rounded-full border-2 transition-all ${currentTheme === 'mint' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-emerald-500`}
              title="Farbthema: Minze"
            ></button>
            <button
              onClick={() => setCurrentTheme('ocean')}
              className={`w-6 h-6 m-1 rounded-full border-2 transition-all ${currentTheme === 'ocean' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-blue-500`}
              title="Farbthema: Ozean"
            ></button>
            <button
              onClick={() => setCurrentTheme('berry')}
              className={`w-6 h-6 m-1 rounded-full border-2 transition-all ${currentTheme === 'berry' ? 'border-theme-title scale-110' : 'border-transparent opacity-70 hover:opacity-100'} bg-purple-500`}
              title="Farbthema: Beere"
            ></button>
          </div>
        </div>
        
        {/* Navigation Wrapper */}
        <div className="flex items-center gap-4">
          {/* Desktop Buttons */}
          <div className="hidden md:flex gap-3">
            <button 
              onClick={() => setIsBackupManagerOpen(true)} 
              className="rounded-full bg-theme-card border border-theme-primary-soft flex items-center justify-center w-10 h-10 text-xl shadow-sm hover:bg-theme-primary-softer transition-all cursor-pointer" 
              title={t('dashboard.backup_manager')}
            >
              💾
            </button>
            <button 
              onClick={() => { signOut(auth); setIsDevMode(false); }} 
              className="rounded-full bg-slate-900 px-6 py-2 text-sm font-bold text-white shadow-md hover:bg-slate-800 transition-all cursor-pointer whitespace-nowrap"
            >
              {t('common.logout')}
            </button>
          </div>

          {/* Mobile Burger Icon (now centered below title on mobile or side-by-side) */}
          <button 
            onClick={() => setIsMobileMenuOpen(true)} 
            className="md:hidden flex items-center gap-2 px-4 py-2 bg-theme-card rounded-full shadow-sm text-sm font-bold cursor-pointer text-theme-muted-strong border border-theme-border hover:bg-theme-bg-soft transition-all"
          >
            <span>{t('common.menu')}</span>
            <span className="text-lg">☰</span>
          </button>
        </div>
      </header>
      
      <main className="mx-auto max-w-3xl">
        <input 
          type="file" 
          accept="image/*" 
          ref={fileInputRef} 
          onChange={handlePlushUpload} 
          className="hidden" 
        />
        <div className="hidden md:flex gap-2 sm:gap-4 border-b border-theme-primary-border mb-8 overflow-x-auto pb-2 scrollbar-hide">
          <button onClick={() => setActiveTab('dashboard')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'dashboard' ? 'border-theme-primary text-theme-primary' : 'border-transparent text-theme-muted hover:text-theme-primary'}`}>{t('dashboard.new_story_nav')}</button>
          <button onClick={() => setActiveTab('avatars')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'avatars' ? 'border-theme-primary text-theme-primary' : 'border-transparent text-theme-muted hover:text-theme-primary'}`}>🦸 Helden-Galerie</button>
          <button onClick={() => setActiveTab('create')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'create' ? 'border-theme-primary text-theme-primary' : 'border-transparent text-theme-muted hover:text-theme-primary'}`}>{t('dashboard.new_story')}</button>
          <button onClick={() => setActiveTab('library')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'library' ? 'border-theme-primary text-theme-primary' : 'border-transparent text-theme-muted hover:text-theme-primary'}`}>{t('library.title')} ({allBooks.length})</button>
          <button onClick={() => setActiveTab('books')} className={`p-3 sm:p-4 font-bold border-b-4 transition whitespace-nowrap ${activeTab === 'books' ? 'border-theme-primary text-theme-primary' : 'border-transparent text-theme-muted hover:text-theme-primary'}`}>{t('book.title')} ({allFinishedBooks.length})</button>
        </div>

        {activeTab === 'dashboard' ? <Dashboard /> : activeTab === 'avatars' ? (
          <div className="mb-8 rounded-[40px] bg-theme-card p-8 shadow-xl border-4 border-theme-primary-softer">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <h2 className="text-2xl font-bold text-theme-title">Deine Helden-Galerie</h2>
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-2">
                  <input 
                    type="text" 
                    placeholder="Name des Kuscheltiers" 
                    value={plushName} 
                    onChange={e => setPlushName(e.target.value)} 
                    className="border border-theme-border rounded-full px-4 py-3 focus:outline-none focus:border-theme-primary"
                  />
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploadingPlush || !plushName.trim()}
                    className="px-6 py-3 bg-theme-primary text-white font-bold rounded-full shadow-md hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 active:shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    <span className="text-xl">🧸</span> 
                    {isUploadingPlush ? 'Wird verzaubert...' : 'Foto hochladen'}
                  </button>
                </div>
              </div>
            </div>
            {uploadError && (
              <div className="mb-6 p-4 bg-red-100 border border-red-200 text-red-700 rounded-2xl text-sm font-bold">
                {uploadError}
              </div>
            )}
            
            {savedAvatars.length === 0 ? (
              <p className="text-theme-muted italic">Du hast noch keine Helden gespeichert. Erstelle ein Buch und speichere den Helden im Buch-Skript!</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6">
                {savedAvatars.map(avatar => (
                  <div 
                    key={avatar.id} 
                    className="flex flex-col items-center gap-3 cursor-pointer group relative"
                    onClick={() => {
                      if (editingHeroId !== avatar.id) {
                        setSelectedAvatarId(avatar.id);
                        setActiveTab('create');
                      }
                    }}
                  >
                    <div className="relative w-full">
                      <img src={avatar.imageUrl} alt={avatar.avatarName} className="w-full aspect-square object-cover rounded-3xl shadow-sm border-4 border-theme-bg-softer group-hover:border-theme-primary transition-all duration-300" />
                      <div className={`absolute inset-0 rounded-3xl bg-theme-primary/10 transition-opacity flex items-center justify-center ${editingHeroId === avatar.id ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'}`}>
                        <span className="bg-white text-theme-primary font-bold px-3 py-1 rounded-full shadow text-xs">Aussuchen</span>
                      </div>
                    </div>
                    {editingHeroId === avatar.id ? (
                      <div className="flex flex-col items-center gap-1 w-full" onClick={e => e.stopPropagation()}>
                        <input 
                          autoFocus
                          type="text" 
                          value={editingHeroName}
                          onChange={(e) => setEditingHeroName(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter') {
                              await updateDoc(doc(db, 'avatars', avatar.id), { avatarName: editingHeroName });
                              setEditingHeroId(null);
                            } else if (e.key === 'Escape') {
                              setEditingHeroId(null);
                            }
                          }}
                          onBlur={async () => {
                            await updateDoc(doc(db, 'avatars', avatar.id), { avatarName: editingHeroName });
                            setEditingHeroId(null);
                          }}
                          className="w-full text-center border-b-2 border-theme-primary outline-none bg-transparent font-bold text-sm"
                        />
                        <span className="text-[9px] text-theme-muted">Enter zum Speichern</span>
                      </div>
                    ) : (
                      <span className="font-bold text-sm text-theme-base group-hover:text-theme-primary-strong transition-colors text-center px-2">{avatar.avatarName}</span>
                    )}
                    
                    {editingHeroId !== avatar.id && (
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2">
                         <button 
                          onClick={(e) => { e.stopPropagation(); setEditingHeroName(avatar.avatarName); setEditingHeroId(avatar.id); }}
                          className="text-xs bg-white text-theme-base px-2 py-1 rounded shadow-sm hover:text-theme-primary"
                        >
                          ✏️
                        </button>
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDeleteAvatar(avatar.id); }}
                          className="text-xs bg-white text-red-600 px-2 py-1 rounded shadow-sm hover:text-red-800"
                        >
                          🗑️
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'create' ? (
          <>
            <div className="mb-8 rounded-[40px] bg-theme-card p-8 shadow-xl border-4 border-theme-primary-softer">
              <textarea
                id="ideaTextarea"
                className="w-full rounded-3xl bg-theme-bg-soft border-2 border-theme-border p-6 text-lg focus:outline-none focus:border-theme-primary-border transition-all"
                rows={4}
                placeholder={t('create.placeholder')}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
              />
              
              <div className="mt-6 mb-2">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-3 gap-2">
                  <h3 className="font-bold text-theme-base text-sm">Oder wähle einen deiner Helden:</h3>
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <input 
                      type="text" 
                      placeholder="Name des Kuscheltiers" 
                      value={plushName} 
                      onChange={e => setPlushName(e.target.value)} 
                      className="text-xs border border-theme-border rounded-full px-3 py-1.5 focus:outline-none focus:border-theme-primary w-full sm:w-auto"
                    />
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploadingPlush || !plushName.trim()}
                      className="whitespace-nowrap text-xs bg-theme-primary/10 text-theme-primary-strong px-3 py-1.5 rounded-full font-bold hover:bg-theme-primary/20 transition-colors flex items-center gap-1 disabled:opacity-50"
                    >
                      <span>🧸</span> {isUploadingPlush ? '...' : 'Foto hochladen'}
                    </button>
                  </div>
                </div>
                {uploadError && (
                  <div className="mb-3 p-3 bg-red-100 border border-red-200 text-red-700 rounded-xl text-xs font-bold">
                    {uploadError}
                  </div>
                )}
                {savedAvatars.length === 0 ? (
                  <p className="text-xs text-theme-muted italic">Noch keine Helden gespeichert. Erstelle eine Geschichte und speichere deinen ersten Held in der Helden-Galerie!</p>
                ) : (
                  <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide snap-x">
                    {savedAvatars.map(avatar => (
                      <div 
                        key={avatar.id}
                        onClick={() => setSelectedAvatarId(selectedAvatarId === avatar.id ? null : avatar.id)}
                        className={`min-w-[80px] w-20 flex flex-col items-center gap-2 cursor-pointer transition-all snap-start ${selectedAvatarId === avatar.id ? 'scale-110 opacity-100' : 'opacity-60 hover:opacity-100'}`}
                        title={avatar.avatarName}
                      >
                        <img src={avatar.imageUrl} alt={avatar.avatarName} className={`w-20 h-20 rounded-2xl object-cover border-4 ${selectedAvatarId === avatar.id ? 'border-theme-primary shadow-lg' : 'border-transparent shadow-sm'}`} />
                        <span className={`text-[10px] font-bold text-center truncate w-full px-1 ${selectedAvatarId === avatar.id ? 'text-theme-primary-strong' : 'text-theme-muted'}`}>{avatar.avatarName}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={handleGenerateInspiration}
                disabled={isInspirationLoading}
                className="mt-2 text-sm font-bold text-theme-primary hover:text-theme-primary-strong flex items-center justify-center gap-2 w-full py-2"
              >
                {isInspirationLoading ? t('create.inspiration_loading') : t('create.inspiration_btn')}
              </button>
              <button
                id="generateButton"
                onClick={handleGenerate}
                disabled={isLoading || !idea}
                className="mt-6 w-full rounded-3xl bg-theme-primary py-5 text-xl font-bold text-white transition-all shadow-[0_8px_0_rgb(194,65,12)] active:translate-y-1 active:shadow-none disabled:bg-slate-300 disabled:shadow-none"
              >
                {isLoading ? t('create.generate_loading') : t('create.generate_btn')}
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
                          ? 'bg-theme-primary-soft border-theme-primary text-theme-primary-strong' 
                          : 'bg-theme-card border-theme-border text-theme-muted-strong hover:border-theme-primary-border'
                      }`}
                    >
                      {titel}
                    </div>
                  ))}
                </section>
                
                <section className="rounded-[40px] bg-theme-card p-8 shadow-md border-2 border-theme-border">
                  <h2 className="mb-6 text-2xl font-bold text-theme-base">Story Kurzskript</h2>
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
                    <div className="flex-1 space-y-3">
                      <div className="flex items-center gap-2 mb-2">
                         <h2 className="text-xl font-bold text-green-800">Held:</h2>
                         <input type="text" value={result.hauptcharakter.name || ""} onChange={(e) => { setResult({...result, hauptcharakter: {...result.hauptcharakter, name: e.target.value}}); updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.name': e.target.value }); }} className="font-bold text-green-800 text-xl border-b-2 border-transparent hover:border-green-300 focus:border-green-500 bg-transparent outline-none w-full" />
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-xs font-bold text-green-600 block mb-1">Gattung</label>
                          <input type="text" value={result.hauptcharakter.gattung || ""} onChange={(e) => setResult({...result, hauptcharakter: {...result.hauptcharakter, gattung: e.target.value}})} onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.gattung': result.hauptcharakter.gattung })} className="w-full text-sm text-green-900 border-b border-green-200 hover:border-green-400 focus:border-green-500 bg-transparent outline-none pb-1" />
                        </div>
                        <div>
                          <label className="text-xs font-bold text-green-600 block mb-1">Persönlichkeit</label>
                          <input type="text" value={result.hauptcharakter.persoenlichkeit || ""} onChange={(e) => setResult({...result, hauptcharakter: {...result.hauptcharakter, persoenlichkeit: e.target.value}})} onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.persoenlichkeit': result.hauptcharakter.persoenlichkeit })} className="w-full text-sm text-green-900 border-b border-green-200 hover:border-green-400 focus:border-green-500 bg-transparent outline-none pb-1" />
                        </div>
                        <div>
                          <label className="text-xs font-bold text-green-600 block mb-1">Hobbys</label>
                          <input type="text" value={result.hauptcharakter.hobbys || ""} placeholder="Bsp: Verstecken spielen" onChange={(e) => setResult({...result, hauptcharakter: {...result.hauptcharakter, hobbys: e.target.value}})} onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.hobbys': result.hauptcharakter.hobbys })} className="w-full text-sm text-green-900 border-b border-green-200 hover:border-green-400 focus:border-green-500 bg-transparent outline-none pb-1" />
                        </div>
                        <div>
                          <label className="text-xs font-bold text-green-600 block mb-1">Lieblingsessen</label>
                          <input type="text" value={result.hauptcharakter.lieblingsessen || ""} placeholder="Bsp: Honig mit Beeren" onChange={(e) => setResult({...result, hauptcharakter: {...result.hauptcharakter, lieblingsessen: e.target.value}})} onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.lieblingsessen': result.hauptcharakter.lieblingsessen })} className="w-full text-sm text-green-900 border-b border-green-200 hover:border-green-400 focus:border-green-500 bg-transparent outline-none pb-1" />
                        </div>
                        <div>
                          <label className="text-xs font-bold text-green-600 block mb-1">Ängste</label>
                          <input type="text" value={result.hauptcharakter.aengste || ""} placeholder="Bsp: Gewitter" onChange={(e) => setResult({...result, hauptcharakter: {...result.hauptcharakter, aengste: e.target.value}})} onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.aengste': result.hauptcharakter.aengste })} className="w-full text-sm text-green-900 border-b border-green-200 hover:border-green-400 focus:border-green-500 bg-transparent outline-none pb-1" />
                        </div>
                      </div>

                      <div className="mt-4">
                        <label className="text-xs font-bold text-green-600 block mb-1">Aussehen (für KI-Prompt)</label>
                        <textarea value={result.hauptcharakter.aussehen_de || ""} onChange={(e) => setResult({...result, hauptcharakter: {...result.hauptcharakter, aussehen_de: e.target.value}})} onBlur={() => updateDoc(doc(db, 'buecher', result.id), { 'hauptcharakter.aussehen_de': result.hauptcharakter.aussehen_de })} className="w-full text-sm text-green-900 bg-green-100 p-3 rounded-xl outline-none resize-none focus:ring-2 focus:ring-green-400" rows={2} />
                      </div>
                    </div>
                    <div className="flex flex-col items-center gap-4">
                      <div id="characterImagePlaceholder" className="flex-none w-48 h-48 rounded-2xl bg-theme-card flex items-center justify-center text-theme-muted-light border-dashed border-4 border-theme-border-strong overflow-hidden">
                        {isImageLoading ? (
                          <div className="flex flex-col items-center">
                            <div className="animate-spin text-4xl mb-2">⏳</div>
                            <p className="text-[10px] text-center px-1">Nano Banana 2 zeichnet {result.hauptcharakter.name}...</p>
                          </div>
                        ) : result.hauptcharakter.avatar_url ? (
                          <img src={result.hauptcharakter.avatar_url} alt="Held" className="w-full h-full object-cover" />
                        ) : (
                          <button 
                            onClick={async () => {
                              const newAvatarUrl = await generateCharacterImage(result.id, result.hauptcharakter.bild_prompt_en);
                              if (newAvatarUrl) {
                                setResult({...result, hauptcharakter: {...result.hauptcharakter, avatar_url: newAvatarUrl}});
                              }
                            }} 
                            className="text-xs text-center p-2 cursor-pointer hover:text-theme-primary font-bold"
                          >
                            Charakterbild generieren
                          </button>
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
                          className="w-full max-w-48 rounded-full bg-theme-card border border-theme-border-strong py-2 text-xs font-bold text-theme-muted hover:bg-theme-bg-soft transition-colors shadow-sm cursor-pointer disabled:opacity-50"
                        >
                          {isImageLoading ? "🔄 Generiere..." : "🔄 Bild neu generieren"}
                        </button>
                      )}
                      {result.hauptcharakter.avatar_url && (
                        savingAvatarRef?.id === result.id ? (
                          <div className="w-full max-w-48 bg-theme-card border border-theme-border p-3 rounded-[24px] shadow-sm flex flex-col gap-2 mt-2">
                            <input 
                              type="text" 
                              placeholder="Name für Galerie..." 
                              value={newAvatarName}
                              onChange={e => setNewAvatarName(e.target.value)}
                              className="text-xs p-2 bg-theme-bg-soft rounded-lg focus:outline-none"
                            />
                            <div className="flex gap-2">
                              <button onClick={() => setSavingAvatarRef(null)} className="flex-1 text-[10px] py-1 bg-theme-bg-soft text-theme-muted rounded hover:bg-theme-bg-mute cursor-pointer">Abbrechen</button>
                              <button disabled={isAvatarSaving || !newAvatarName} onClick={handleSaveAvatar} className="flex-1 text-[10px] py-1 bg-emerald-500 text-white font-bold rounded shadow hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">{isAvatarSaving ? '...' : 'Speichern'}</button>
                            </div>
                          </div>
                        ) : (
                          <button 
                            onClick={() => {
                              setSavingAvatarRef(result);
                              setNewAvatarName(result.hauptcharakter.name || '');
                            }}
                            className="mt-2 w-full max-w-48 rounded-full bg-theme-primary/10 border border-theme-primary-soft py-2 text-xs font-bold text-theme-primary-strong hover:bg-theme-primary/20 transition-colors shadow-sm cursor-pointer"
                          >
                            ⭐ In Helden-Galerie speichern
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </section>
                
                <div className="flex justify-center mt-12 pb-8">
                  <button 
                    onClick={() => setSelectedSkriptForBook(result)} 
                    className="px-8 py-4 rounded-full bg-slate-900 text-white font-bold text-lg shadow-[0_4px_0_rgb(15,23,42)] hover:-translate-y-1 hover:shadow-[0_6px_0_rgb(15,23,42)] active:translate-y-1 active:shadow-none transition-all cursor-pointer"
                  >
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
                {selectedBooks.size} {t('library.delete_count')}
              </button>
            )}
            {allBooks.map(book => (
              <div key={book.id} className="relative rounded-[30px] bg-theme-card p-6 shadow-sm border border-theme-border flex flex-col gap-4">
                <input type="checkbox" onChange={() => handleToggleSelectBook(book.id)} checked={selectedBooks.has(book.id)} className="absolute top-4 left-4" />
                <img src={book.hauptcharakter.avatar_url || ''} alt="" onClick={() => setEditingBook(book)} className="w-full h-40 object-cover rounded-2xl bg-theme-bg-softer cursor-pointer" />
                <h3 className="font-bold text-lg">{book.ausgewaehlter_titel || t('library.untitled')}</h3>
                <div className="flex justify-between items-center text-sm font-bold text-theme-muted">
                  <span>{book.created_at ? new Date(book.created_at.seconds * 1000).toLocaleDateString() : t('library.unknown_date')}</span>
                  {currentUser?.email === ADMIN_EMAIL && book.cost_metrics && <span>💰 ${book.cost_metrics.total_cost_usd.toFixed(2)}</span>}
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setSelectedSkriptForBook(book)} 
                    disabled={(book.erzeugteBuecherCount || 0) >= 3}
                    className="flex-[2] bg-indigo-500 text-white py-2 rounded-full font-bold hover:bg-indigo-600 transition-colors shadow-sm cursor-pointer border border-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed">
                    {(book.erzeugteBuecherCount || 0) >= 3 ? t('library.limit_reached') : t('library.create_book')}
                  </button>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditingBook(book)} className="flex-1 bg-theme-bg-softer text-theme-muted-strong py-2 rounded-full font-bold hover:bg-theme-bg-mute cursor-pointer transition-colors">{t('library.edit')}</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteBook(book.id); }} className="bg-red-50 text-red-500 py-2 px-4 rounded-full font-bold relative z-20 cursor-pointer hover:bg-red-100 transition-colors">🗑️</button>
                </div>
              </div>
            ))}
          </div>
        ) : activeTab === 'books' ? (
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-center bg-theme-card p-4 rounded-[24px] shadow-sm border border-theme-border flex-wrap gap-4">
              <label className="flex items-center gap-3 font-bold text-theme-muted-strong cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={showOnlyFavorites} 
                  onChange={(e) => setShowOnlyFavorites(e.target.checked)}
                  className="w-5 h-5 rounded text-indigo-500 focus:ring-indigo-500 border-slate-300"
                />
                {t('book.show_favorites')}
              </label>
              {activeLabelFilter && (() => {
                const activeCfg = customLabels.find(l => l.id === activeLabelFilter);
                return (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-theme-muted font-medium">{t('book.filter')}</span>
                    <span className={`text-sm font-bold px-3 py-1 rounded-full flex items-center gap-2 shadow-sm ${activeCfg?.colorClass || 'bg-theme-bg-softer text-theme-base'}`}>
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
                className="text-sm font-medium text-theme-muted hover:text-indigo-600 bg-theme-bg-soft hover:bg-indigo-50 px-3 py-1.5 rounded-full transition-colors flex items-center gap-2"
              >
                {t('book.adjust_labels')}
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {filteredFinishedBooks.length === 0 && (
                <p className="text-theme-muted col-span-2 text-center py-12">{showOnlyFavorites ? t('book.no_favorites_found') : t('book.no_books_found')}</p>
              )}
              {filteredFinishedBooks.map(book => (
                <div key={book.id} className="relative rounded-[30px] bg-theme-card p-6 shadow-sm border border-theme-border flex flex-col gap-4 cursor-pointer hover:shadow-md transition-shadow" onClick={() => setReadingBook(book)}>
                  <button 
                    onClick={(e) => handleToggleFavorite(e, book)} 
                    className="absolute top-8 right-8 z-10 w-10 h-10 bg-theme-card/80 backdrop-blur-md rounded-full flex items-center justify-center text-xl shadow-sm hover:scale-110 transition-transform cursor-pointer"
                  >
                    {book.isFavorite ? '❤️' : '🤍'}
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setShowDeleteFinishedConfirm(book.id); }} 
                    className="absolute top-8 left-8 z-10 w-10 h-10 bg-theme-card/80 backdrop-blur-md rounded-full flex items-center justify-center text-xl shadow-sm hover:scale-110 hover:bg-red-50 transition-all cursor-pointer"
                    title="Buch löschen"
                  >
                    🗑️
                  </button>
                  <img src={book.coverImage || ''} alt="Cover" className="w-full h-48 object-cover rounded-2xl bg-amber-50" />
                  <h3 className="font-bold text-xl text-theme-base">{book.titel}</h3>
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="bg-indigo-100 text-indigo-800 text-xs font-bold px-2 py-1 rounded-md">{getTranslatedLabel('zielalter', book.zielalter)}</span>
                    <span className="bg-pink-100 text-pink-800 text-xs font-bold px-2 py-1 rounded-md">{getTranslatedLabel('stimmung', book.stimmung)}</span>
                    <span className="bg-theme-bg-softer text-theme-muted text-xs font-bold px-2 py-1 rounded-md">{book.seitenAnzahl} {t('book.pages_suffix')}</span>
                    {currentUser?.email === ADMIN_EMAIL && book.kosten_protokoll && (
                      <div className="relative group ml-1">
                        <div className="text-xs bg-emerald-100 text-emerald-800 font-bold px-2 py-1 rounded-md cursor-help">
                          💰 ${(book.kosten_protokoll.gesamt_kosten_usd || 0).toFixed(4)}
                        </div>
                        <div className="absolute bottom-full right-0 mb-2 w-64 bg-slate-900 border border-slate-700 shadow-xl rounded-xl p-4 text-xs text-slate-300 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                          <div className="font-bold text-white mb-2 pb-2 border-b border-slate-700">Detailed Cost Protocol</div>
                          <div className="flex justify-between mb-1">
                            <span>1. Entwurf:</span>
                            <span className="font-mono text-emerald-400">${(book.kosten_protokoll.entwurf?.cost || 0).toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between mb-1">
                            <span>2. Ausarbeitung:</span>
                            <span className="font-mono text-emerald-400">${(book.kosten_protokoll.ausarbeitung?.cost || 0).toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between mb-1">
                            <span>2.5 Lektorat:</span>
                            <span className="font-mono text-emerald-400">${(book.kosten_protokoll.lektorat?.cost || 0).toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between pt-1 mt-1 border-t border-slate-700/50">
                            <span>3. Bilder ({book.kosten_protokoll.bilder?.anzahl || 0}x):</span>
                            <span className="font-mono text-emerald-400">${(book.kosten_protokoll.bilder?.cost || 0).toFixed(4)}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-2 pt-4 border-t border-slate-50">
                    <span className="text-xs text-theme-muted-light font-bold uppercase tracking-wider">Label:</span>
                    <div className="flex gap-2">
                      {customLabels.map(l => {
                        const isActive = book.labelId === l.id;
                        return (
                          <button
                            key={l.id}
                            onClick={(e) => { e.stopPropagation(); handleSetLabel(book, l.id); }}
                            title={l.name}
                            className={`w-6 h-6 rounded-full transition-all border-2 ${isActive ? l.colorClass + ' border-transparent scale-110 shadow-sm' : 'border-theme-border-strong bg-theme-card hover:border-slate-300'}`}
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
            <div className="w-24 h-24 bg-theme-card/20 rounded-full flex items-center justify-center animate-bounce mb-8 shadow-2xl">
              <span className="text-5xl">📖</span>
            </div>
            <h2 className="text-3xl font-bold text-white mb-4">{generationStep}</h2>
            <div className="flex gap-2">
              <div className="w-3 h-3 bg-theme-card rounded-full animate-bounce delay-75"></div>
              <div className="w-3 h-3 bg-theme-card rounded-full animate-bounce delay-150"></div>
              <div className="w-3 h-3 bg-theme-card rounded-full animate-bounce delay-300"></div>
            </div>
            <p className="mt-8 text-indigo-200 text-sm italic">"{t('create.patience_hint')}"</p>
        </div>
      )}

      {/* Configurator Modal */}
      {selectedSkriptForBook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-[32px] bg-theme-card p-8 shadow-2xl">
            <h3 className="mb-6 text-2xl font-bold text-theme-base">{t('create.config_title')}</h3>
            
            {error && (
              <div className="mb-6 rounded-2xl bg-red-100 p-4 text-red-800 border border-red-200 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-bold text-theme-muted mb-3">{t('create.age_label')}</label>
                <div className="flex gap-2">
                  {['2-4 Jahre', '4-6 Jahre', '6-8 Jahre'].map(alter => (
                    <button 
                      key={alter}
                      onClick={() => setBookConfig({ ...bookConfig, zielalter: alter })}
                      className={`flex-1 py-2 rounded-xl text-sm font-bold border-2 transition-colors cursor-pointer ${bookConfig.zielalter === alter ? 'border-theme-primary text-theme-primary bg-theme-primary-softer' : 'border-theme-border text-theme-muted hover:border-theme-border-strong'}`}
                    >
                      {alter === '2-4 Jahre' ? t('create.age_2_4') : alter === '4-6 Jahre' ? t('create.age_4_6') : t('create.age_6_8')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-theme-muted mb-3">{t('create.mood_label')}</label>
                <div className="flex flex-wrap gap-2">
                  {['Lustig', 'Träumerisch', 'Lehrreich', 'Spannend'].map(stimmung => (
                    <button 
                      key={stimmung}
                      onClick={() => setBookConfig({ ...bookConfig, stimmung })}
                      className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-colors cursor-pointer ${bookConfig.stimmung === stimmung ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-theme-border text-theme-muted hover:border-theme-border-strong'}`}
                    >
                      {stimmung === 'Lustig' ? t('create.mood_funny') : stimmung === 'Träumerisch' ? t('create.mood_dreamy') : stimmung === 'Lehrreich' ? t('create.mood_educational') : t('create.mood_exciting')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-theme-muted mb-3">{t('create.pages_label')}</label>
                <select 
                  className="w-full rounded-xl border-2 border-theme-border p-3 font-bold text-theme-muted-strong outline-none focus:border-slate-300"
                  value={bookConfig.seitenAnzahl}
                  onChange={(e) => setBookConfig({ ...bookConfig, seitenAnzahl: parseInt(e.target.value) })}
                >
                  {(bookConfig.zielalter === '2-4 Jahre' ? [8, 12] : bookConfig.zielalter === '4-6 Jahre' ? [12, 16, 24] : [16, 24]).map(num => (
                    <option key={num} value={num}>{num} {t('create.pages_suffix')}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-4 mt-8 pt-6 border-t border-theme-border">
                <button onClick={() => setSelectedSkriptForBook(null)} className="flex-1 rounded-full bg-theme-bg-softer py-3 font-bold text-theme-muted-strong hover:bg-theme-bg-mute cursor-pointer">{t('common.cancel')}</button>
                <button 
                  onClick={handleGenerateBook} 
                  disabled={isGeneratingBook}
                  className="flex-[2] rounded-full bg-indigo-500 py-3 font-bold text-white shadow-[0_4px_0_rgb(67,56,202)] hover:bg-indigo-600 active:translate-y-1 active:shadow-none cursor-pointer border border-indigo-400 disabled:opacity-50 disabled:translate-y-1 disabled:shadow-none"
                >
                  {isGeneratingBook ? t('common.loading') : t('create.generate_book_btn')}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-[32px] bg-theme-card p-8 shadow-2xl">
            <h3 className="mb-4 text-2xl font-bold text-theme-base">{t('common.confirm_delete_title')}</h3>
            <p className="mb-8 text-theme-muted">{t('common.confirm_delete_desc')}</p>
            <div className="flex gap-4">
              <button onClick={() => setShowDeleteConfirm(null)} className="flex-1 rounded-full bg-theme-bg-softer py-3 font-bold text-theme-muted-strong hover:bg-theme-bg-mute cursor-pointer">{t('common.cancel')}</button>
              <button onClick={confirmDelete} className="flex-1 rounded-full bg-red-500 py-3 font-bold text-white shadow-[0_4px_0_rgb(153,27,27)] hover:bg-red-600 active:translate-y-1 active:shadow-none cursor-pointer">{t('common.delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Finished Book Confirmation Modal */}
      {showDeleteFinishedConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-[32px] bg-theme-card p-8 shadow-2xl">
            <h3 className="mb-4 text-2xl font-bold text-theme-base">{t('common.confirm_delete_title')}</h3>
            <p className="mb-8 text-theme-muted">{t('common.confirm_delete_book_desc')}</p>
            <div className="flex gap-4">
              <button 
                onClick={() => setShowDeleteFinishedConfirm(null)} 
                className="flex-1 rounded-full bg-theme-bg-softer py-3 font-bold text-theme-muted-strong hover:bg-theme-bg-mute cursor-pointer transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button 
                onClick={confirmDeleteFinishedBook} 
                className="flex-[1] bg-red-500 text-white font-bold py-3 rounded-full hover:bg-red-600 transition shadow-[0_4px_0_rgb(153,27,27)] active:translate-y-1 active:shadow-none cursor-pointer"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingBook && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-4xl rounded-[40px] bg-theme-card p-8 shadow-2xl my-8 max-h-[90vh] overflow-y-auto">
            <h3 className="mb-6 text-3xl font-bold text-theme-base">📖 Kurzskript bearbeiten</h3>
            
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-bold text-theme-muted mb-2 uppercase tracking-widest">Titel</label>
                <input 
                  type="text" 
                  value={editingBook.ausgewaehlter_titel || editingBook.titel_optionen[0] || ""}
                  onChange={(e) => setEditingBook({...editingBook, ausgewaehlter_titel: e.target.value})}
                  className="w-full rounded-2xl bg-theme-bg-soft border-2 border-theme-border p-4 font-bold text-theme-base text-xl focus:outline-none focus:border-theme-primary transition-colors"
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

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 bg-[#F2FCEF] p-6 rounded-[30px] border border-green-200">
                <div className="col-span-full">
                  <h4 className="font-bold text-green-800 uppercase tracking-widest text-xs mb-2">Charakter-Profil</h4>
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-green-700 mb-2">Name</label>
                  <input type="text" value={editingBook.hauptcharakter.name || ""} onChange={(e) => setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, name: e.target.value}})} className="rounded-xl border border-green-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 bg-white" />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-green-700 mb-2">Gattung</label>
                  <input type="text" value={editingBook.hauptcharakter.gattung || ""} onChange={(e) => setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, gattung: e.target.value}})} className="rounded-xl border border-green-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 bg-white" />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-green-700 mb-2">Persönlichkeit</label>
                  <input type="text" value={editingBook.hauptcharakter.persoenlichkeit || ""} onChange={(e) => setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, persoenlichkeit: e.target.value}})} className="rounded-xl border border-green-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 bg-white" />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-green-700 mb-2">Hobbys</label>
                  <input type="text" value={editingBook.hauptcharakter.hobbys || ""} onChange={(e) => setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, hobbys: e.target.value}})} className="rounded-xl border border-green-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 bg-white" placeholder="Was macht der Charakter gerne?" />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-green-700 mb-2">Lieblingsessen</label>
                  <input type="text" value={editingBook.hauptcharakter.lieblingsessen || ""} onChange={(e) => setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, lieblingsessen: e.target.value}})} className="rounded-xl border border-green-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 bg-white" placeholder="Was isst er am liebsten?" />
                </div>
                <div className="flex flex-col">
                  <label className="block text-xs font-bold text-green-700 mb-2">Ängste</label>
                  <input type="text" value={editingBook.hauptcharakter.aengste || ""} onChange={(e) => setEditingBook({...editingBook, hauptcharakter: {...editingBook.hauptcharakter, aengste: e.target.value}})} className="rounded-xl border border-green-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 bg-white" placeholder="Wovor fürchtet er sich?" />
                </div>
              </div>

              <div className="flex flex-col items-center gap-4 bg-theme-bg-soft p-6 rounded-[30px] border border-theme-border">
                <h4 className="font-bold text-theme-muted uppercase tracking-widest text-xs">Charakter Avatar</h4>
                {editingBook.hauptcharakter.avatar_url ? (
                  <img 
                    src={editingBook.hauptcharakter.avatar_url} 
                    alt="Charakter Avatar" 
                    className="w-48 h-48 object-cover rounded-[24px] shadow-sm mb-2"
                  />
                ) : (
                  <div className="w-48 h-48 bg-theme-bg-mute rounded-[24px] flex items-center justify-center mb-2">
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
                  className="w-full md:w-auto px-8 rounded-full bg-theme-bg-mute py-3 font-bold text-theme-muted-strong hover:bg-slate-300 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {isImageLoading ? "🔄 Generiere..." : "🔄 Bild neu generieren"}
                </button>
                {editingBook.hauptcharakter.avatar_url && (
                  savingAvatarRef?.id === editingBook.id ? (
                    <div className="w-full md:w-48 bg-theme-card border border-theme-border p-3 rounded-[24px] shadow-sm flex flex-col gap-2 mt-2">
                       <input 
                         type="text" 
                         placeholder="Name für Galerie..." 
                         value={newAvatarName}
                         onChange={e => setNewAvatarName(e.target.value)}
                         className="text-xs p-2 bg-theme-bg-soft rounded-lg focus:outline-none w-full"
                       />
                       <div className="flex gap-2">
                         <button onClick={() => setSavingAvatarRef(null)} className="flex-1 text-[10px] py-1 bg-theme-bg-soft text-theme-muted rounded hover:bg-theme-bg-mute cursor-pointer">Abbrechen</button>
                         <button disabled={isAvatarSaving || !newAvatarName} onClick={handleSaveAvatar} className="flex-1 text-[10px] py-1 bg-emerald-500 text-white font-bold rounded shadow hover:bg-emerald-600 disabled:opacity-50 cursor-pointer">{isAvatarSaving ? '...' : 'Speichern'}</button>
                       </div>
                    </div>
                  ) : (
                    <button 
                      onClick={() => {
                        setSavingAvatarRef(editingBook);
                        setNewAvatarName(editingBook.hauptcharakter.name || '');
                      }}
                       className="w-full md:w-auto px-6 rounded-full bg-theme-primary/10 border border-theme-primary-soft py-3 font-bold text-theme-primary-strong hover:bg-theme-primary/20 transition-colors shadow-sm cursor-pointer"
                    >
                      ⭐ In Helden-Galerie speichern
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="flex flex-col md:flex-row gap-4 mt-8 pt-6 border-t border-theme-border">
              <button 
                onClick={() => setEditingBook(null)} 
                className="flex-1 rounded-full bg-theme-bg-softer py-4 font-bold text-theme-muted-strong hover:bg-theme-bg-mute transition-colors cursor-pointer"
              >
                Abbrechen
              </button>
              <button 
                onClick={() => handleUpdateBook(editingBook)} 
                className="flex-1 rounded-full bg-theme-primary-soft py-4 font-bold text-theme-primary-strong hover:bg-theme-primary-border transition-colors cursor-pointer"
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
            <div className="flex items-center gap-2">
              {currentUser?.email === ADMIN_EMAIL && !readingBook.pdfUrl && (
                <button 
                  onClick={async (e) => { 
                    e.stopPropagation(); 
                    setIsLoading(true);
                    const url = await generateAndUploadPdf(readingBook);
                    if (url) {
                      setReadingBook({ ...readingBook, pdfUrl: url });
                      setAllFinishedBooks(prev => prev.map(b => b.id === readingBook.id ? { ...b, pdfUrl: url } : b));
                      alert("PDF erfolgreich in die Cloud geladen!");
                    } else {
                      alert("Fehler beim Cloud Upload.");
                    }
                    setIsLoading(false);
                  }} 
                  disabled={isLoading}
                  className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-4 py-2 rounded-full flex items-center gap-2 cursor-pointer transition-colors shrink-0 disabled:opacity-50"
                >
                  ☁️ <span className="hidden sm:inline">In Cloud speichern</span>
                </button>
              )}
              {currentUser?.email === ADMIN_EMAIL && (
                <button onClick={(e) => { 
                    e.stopPropagation(); 
                    if (readingBook.pdfUrl) window.open(readingBook.pdfUrl, '_blank');
                    else handleDownloadPDF(readingBook); 
                }} className="bg-red-500 hover:bg-red-600 text-white font-bold px-4 py-2 rounded-full flex items-center gap-2 cursor-pointer transition-colors shrink-0">
                  📄 <span className="hidden sm:inline">{readingBook.pdfUrl ? 'PDF (Cloud)' : 'PDF Lokaler Download'}</span>
                </button>
              )}
              <button onClick={() => { setReadingBook(null); setCurrentReadingPage(0); }} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-full cursor-pointer transition-colors shrink-0">Schließen</button>
            </div>
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
                               <div className="flex flex-col items-center justify-center h-full w-full bg-theme-bg-softer text-theme-muted p-6 text-center italic">
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
                         <div className="flex-1 bg-[#fdf9f0] text-slate-900 rounded-[32px] p-8 md:p-16 shadow-2xl flex flex-col justify-center items-center relative border border-theme-primary-soft/50">
                            {editingPageIdx === idx ? (
                                <>
                                  <textarea 
                                    className="bg-white/50 text-slate-900 p-6 rounded-2xl w-full flex-1 focus:outline-none resize-none text-xl md:text-2xl font-serif text-center"
                                    value={editingText}
                                    onChange={(e) => setEditingText(e.target.value)}
                                  />
                                  <button onClick={() => handleSavePageText(idx)} className="mt-4 bg-emerald-500 text-white px-8 py-3 rounded-full font-bold">Speichern ✓</button>
                                </>
                            ) : (
                                <>
                                   <p className={`font-serif text-center leading-[1.6] text-slate-900 ${seite.text.length < 150 ? 'text-2xl md:text-3xl lg:text-4xl' : (seite.text.length < 250 ? 'text-xl md:text-2xl lg:text-3xl' : 'text-base md:text-lg lg:text-xl')}`}>{seite.text}</p>
                                   <button 
                                      className="absolute top-6 right-6 bg-theme-primary-soft text-theme-primary rounded-full w-10 h-10 flex items-center justify-center hover:bg-theme-primary-border transition cursor-pointer"
                                      onClick={() => { setEditingPageIdx(idx); setEditingText(seite.text); }}
                                    >
                                      ✏️
                                    </button>
                                </>
                            )}
                            <p className="absolute bottom-6 text-xs text-theme-muted-light font-bold">{idx + 1} / {readingBook.seiten.length}</p>
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
                    <div className="flex-[6] bg-theme-card rounded-t-[32px] overflow-hidden flex items-center justify-center relative shadow-md">
                      {isGeneratingBook ? (
                        <div className="bg-theme-bg-softer w-full h-full flex items-center justify-center animate-pulse text-4xl">🎨</div>
                      ) : seite.imageUrl ? (
                        <img src={seite.imageUrl} alt={`Seite ${idx + 1}`} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                         <div className="bg-theme-bg-soft w-full h-full flex items-center justify-center text-slate-300 text-4xl border-2 border-dashed border-theme-border-strong">🖼️</div>
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
                      <p className="text-right text-xs text-theme-muted mt-2">{idx + 1} / {readingBook.seiten.length}</p>
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
          <div className="bg-theme-card rounded-[40px] p-8 w-full max-w-lg shadow-2xl relative">
            <h2 className="text-3xl font-bold text-theme-base mb-6 flex items-center gap-3">
              ☁️ Backup-Manager
            </h2>
            
            <div className="space-y-6">
              <div className="bg-indigo-50 border border-indigo-100 rounded-[24px] p-6 space-y-4">
                <h3 className="font-bold text-indigo-900 text-lg">Manuelles Backup</h3>
                <div className="flex flex-col sm:flex-row gap-4">
                  <button 
                    onClick={handleDownloadBackup}
                    disabled={isBackupLoading}
                    className="flex-1 bg-theme-card text-indigo-700 py-3 rounded-full font-bold shadow-sm hover:shadow-md transition-all sm:text-sm cursor-pointer disabled:opacity-50"
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
              
              <div className="bg-theme-bg-soft border border-theme-border rounded-[24px] p-6 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-theme-base text-lg">Automatische Backups</h3>
                  <span className="bg-green-100 text-green-800 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full">Täglich</span>
                </div>
                <p className="text-sm text-theme-muted">
                  Die App erstellt jeden Tag beim ersten Start automatisch ein Backup (letzte 7 Tage).
                </p>
                {autoBackups.length > 0 ? (
                  <div className="space-y-2 max-h-[180px] overflow-y-auto pr-2 scrollbar-hide">
                    {autoBackups.map((ab) => (
                      <div key={ab.id || ab.dateString} className="flex justify-between items-center bg-theme-card border border-theme-border rounded-xl p-3 shadow-sm">
                        <span className="font-bold text-theme-muted-strong">{new Date(ab.dateString).toLocaleDateString()}</span>
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
                  <p className="text-sm text-theme-muted-light italic text-center p-4">Noch keine automatischen Backups vorhanden. Das erste wird heute erstellt!</p>
                )}
              </div>
            </div>
            
            <button 
              onClick={() => setIsBackupManagerOpen(false)}
              className="mt-8 w-full py-4 text-theme-muted font-bold hover:bg-theme-bg-softer rounded-full transition-colors cursor-pointer"
            >
              Schließen
            </button>
            {isBackupLoading && (
              <div className="absolute inset-0 bg-theme-card/50 backdrop-blur-sm rounded-[40px] flex items-center justify-center">
                 <div className="animate-spin text-4xl">⏳</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Label Edit Modal */}
      {isEditingLabels && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-theme-card rounded-[32px] p-8 w-full max-w-sm shadow-2xl relative">
            <h2 className="text-2xl font-bold text-theme-base mb-6">Labels anpassen</h2>
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
                    className={`w-full px-4 py-2 bg-theme-bg-soft border border-theme-border-strong rounded-b-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold ${l.colorClass.split(' ')[1]}`}
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
                className="flex-1 py-3 text-theme-muted font-bold hover:bg-theme-bg-softer rounded-xl transition cursor-pointer"
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
          className={`absolute top-0 right-0 bottom-0 w-[280px] bg-theme-card shadow-2xl transition-transform duration-300 ease-in-out transform flex flex-col ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <div className="p-6 border-b border-theme-border flex justify-between items-center bg-theme-primary-softer/50">
            <h2 className="font-magic text-theme-primary text-2xl tracking-normal">Fably</h2>
            <button onClick={() => setIsMobileMenuOpen(false)} className="text-theme-muted text-2xl hover:text-theme-base transition px-2">×</button>
          </div>
          <div className="flex flex-col gap-2 p-4 flex-1 overflow-y-auto">
            <button onClick={() => { setActiveTab('create'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'create' ? 'bg-theme-primary-soft text-theme-primary-strong' : 'bg-theme-bg-soft text-theme-muted hover:bg-theme-bg-softer'}`}>
              <span className="text-xl">📖</span> Neue Geschichte
            </button>
            <button onClick={() => { setActiveTab('avatars'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'avatars' ? 'bg-theme-primary-soft text-theme-primary-strong' : 'bg-theme-bg-soft text-theme-muted hover:bg-theme-bg-softer'}`}>
              <span className="text-xl">🦸</span> Helden-Galerie
            </button>
            <button onClick={() => { setActiveTab('library'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'library' ? 'bg-theme-primary-soft text-theme-primary-strong' : 'bg-theme-bg-soft text-theme-muted hover:bg-theme-bg-softer'}`}>
              <span className="text-xl">📜</span> Meine Kurzskripte <span className="ml-auto bg-theme-card/50 px-2 py-0.5 rounded-full text-xs">{allBooks.length}</span>
            </button>
            <button onClick={() => { setActiveTab('books'); setIsMobileMenuOpen(false); }} className={`p-4 font-bold rounded-2xl flex items-center gap-3 transition-colors text-left ${activeTab === 'books' ? 'bg-theme-primary-soft text-theme-primary-strong' : 'bg-theme-bg-soft text-theme-muted hover:bg-theme-bg-softer'}`}>
              <span className="text-xl">📚</span> Bücher <span className="ml-auto bg-theme-card/50 px-2 py-0.5 rounded-full text-xs">{allFinishedBooks.length}</span>
            </button>
            
            <div className="h-px bg-theme-bg-softer my-2" />
            
            <button onClick={() => { setIsEditingLabels(true); setIsMobileMenuOpen(false); }} className="p-4 font-bold rounded-2xl flex items-center gap-3 bg-theme-bg-soft text-theme-muted hover:bg-theme-bg-softer transition-colors text-left">
              <span className="text-xl">🏷️</span> Label-Verwaltung
            </button>
            <button onClick={() => { setIsBackupManagerOpen(true); setIsMobileMenuOpen(false); }} className="p-4 font-bold rounded-2xl flex items-center gap-3 bg-theme-bg-soft text-theme-muted hover:bg-theme-bg-softer transition-colors text-left">
              <span className="text-xl">💾</span> Backup-Manager
            </button>
          </div>
          <div className="p-4 border-t border-theme-border">
            <button onClick={() => { signOut(auth); setIsDevMode(false); setIsMobileMenuOpen(false); }} className="w-full rounded-2xl bg-slate-800 px-6 py-4 font-bold text-white shadow-sm cursor-pointer whitespace-nowrap text-center">
              Ausloggen
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}

