/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { GoogleGenAI } from '@google/genai';
import { db, auth, storage } from './lib/firebase';
import { collection, addDoc, serverTimestamp, getDocs, updateDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
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

  const AdminDashboard = () => {
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
        
        // Handling Firestore timestamps
        const createdAt = book.created_at?.toDate ? book.created_at.toDate() : (book.created_at ? new Date(book.created_at) : null);
        if (createdAt && createdAt >= thirtyDaysAgo) {
          last30Days += book.cost_metrics.total_cost_usd;
        }
      });
      return { total, last30Days, totalInputTokens, totalOutputTokens };
    }, [allBooks]);

    return (
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-3xl bg-white p-6 border border-orange-100 shadow-sm">
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
    );
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
    const response = await fetch(`/api/books/${bookId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete');
  };

  const handleUpdateBook = async (updatedBook: StoryResult) => {
    try {
      await updateDoc(doc(db, 'buecher', updatedBook.id), { ...updatedBook });
      setAllBooks(prev => prev.map(b => b.id === updatedBook.id ? updatedBook : b));
      setEditingBook(null);
    } catch (err) {
      setError('Speichern fehlgeschlagen.');
    }
  };
  
  const handleToggleSelectBook = (bookId: string) => {
    const newSelected = new Set(selectedBooks);
    if (newSelected.has(bookId)) newSelected.delete(bookId);
    else newSelected.add(bookId);
    setSelectedBooks(newSelected);
  };

  const handleDeleteBook = async (bookId: string) => {
    if (!confirm("Wirklich löschen?")) return;
    try {
      await performDeleteBook(bookId);
      setAllBooks(prev => prev.filter(b => b.id !== bookId));
    } catch (err) {
      setError('Löschen fehlgeschlagen.');
    }
  };

  const handleDeleteSelected = async () => {
    if (!confirm(`Markierte ${selectedBooks.size} Geschichten löschen?`)) return;
    try {
      for (const bookId of selectedBooks) {
        await performDeleteBook(bookId);
      }
      setAllBooks(prev => prev.filter(b => !selectedBooks.has(b.id)));
      setSelectedBooks(new Set());
    } catch (err) {
      setError('Mehrfachlöschung fehlgeschlagen.');
    }
  };

  const generateCharacterImage = async () => {
    if (!result) return;
    setIsImageLoading(true);
    setError(null);
    try {
      // Check for paid API key logic
      // @ts-ignore - aistudio is injected in the environment
      if (window.aistudio && typeof window.aistudio.hasSelectedApiKey === 'function') {
        // @ts-ignore
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
          // @ts-ignore
          await window.aistudio.openSelectKey();
        }
      }

      const aiPaid = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY! });

      const response = await aiPaid.models.generateContent({
        model: IMAGE_MODEL,
        contents: {
          parts: [{ text: result.hauptcharakter.bild_prompt_en }],
        },
        config: {
          imageConfig: {
            aspectRatio: "1:1",
            imageSize: "1K"
          },
        },
      });

      let base64Image = '';
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          base64Image = part.inlineData.data;
          break;
        }
      }

      if (!base64Image) throw new Error('Bild konnte nicht generiert werden.');

      // Upload to Storage
      const storageRef = ref(storage, `buecher/${result.id}/charakter_avatar.png`);
      const blob = await fetch(`data:image/png;base64,${base64Image}`).then(r => r.blob());
      await uploadBytes(storageRef, blob);
      const url = await getDownloadURL(storageRef);

      // Update Firestore
      await updateDoc(doc(db, 'buecher', result.id), {
        'hauptcharakter.avatar_url': url
      });

      await fetch('/api/track-cost', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          bookId: result.id,
          usage: {
            imageGenerated: true
          }
        })
      });

      setResult(prev => prev ? ({ ...prev, hauptcharakter: { ...prev.hauptcharakter, avatar_url: url } }) : null);
    } catch (err) {
      console.error(err);
      setError('Bildgenerierung oder Upload fehlgeschlagen.');
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
            {currentUser?.email === ADMIN_EMAIL && <AdminDashboard />}
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
                      {currentUser?.email === ADMIN_EMAIL && result.cost_metrics && (
                          <div className="mt-2 text-xs text-orange-700 bg-orange-50 rounded-full px-2 py-1">
                            💰 Kosten: ${result.cost_metrics.total_cost_usd.toFixed(2)}
                          </div>
                      )}
                    </div>
                  ))}
                </section>
                
                <section className="rounded-[40px] bg-white p-8 shadow-md border-2 border-slate-100">
                  <h2 className="mb-6 text-2xl font-bold text-slate-800">Die Story</h2>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="rounded-3xl bg-yellow-50 p-6 border border-yellow-100">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-yellow-600 mb-2">Anfang</h3>
                      <p className="text-sm leading-relaxed text-yellow-900">{result.storyline.anfang}</p>
                    </div>
                    <div className="rounded-3xl bg-pink-50 p-6 border border-pink-100">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-pink-600 mb-2">Mitte</h3>
                      <p className="text-sm leading-relaxed text-pink-900">{result.storyline.mitte}</p>
                    </div>
                    <div className="rounded-3xl bg-purple-50 p-6 border border-purple-100">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-purple-600 mb-2">Ende</h3>
                      <p className="text-sm leading-relaxed text-purple-900">{result.storyline.ende}</p>
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
                    <div id="characterImagePlaceholder" className="flex-none w-48 h-48 rounded-2xl bg-white flex items-center justify-center text-slate-400 border-dashed border-4 border-slate-200 overflow-hidden">
                      {isImageLoading ? (
                        <div className="flex flex-col items-center">
                          <div className="animate-spin text-4xl mb-2">⏳</div>
                          <p className="text-[10px] text-center px-1">Nano Banana 2 zeichnet {result.hauptcharakter.name}...</p>
                        </div>
                      ) : result.hauptcharakter.avatar_url ? (
                        <img src={result.hauptcharakter.avatar_url} alt="Held" className="w-full h-full object-cover" />
                      ) : (
                        <button onClick={generateCharacterImage} className="text-xs text-center p-2">Charakterbild generieren</button>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {allBooks.length > 0 && selectedBooks.size > 0 && (
              <button onClick={handleDeleteSelected} className="md:col-span-2 mb-4 bg-red-500 text-white font-bold py-2 px-4 rounded-full">
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
                  <button onClick={() => setEditingBook(book)} className="flex-1 bg-slate-100 text-slate-700 py-2 rounded-full font-bold">Bearbeiten</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteBook(book.id); }} className="bg-red-50 text-red-500 py-2 px-4 rounded-full font-bold relative z-20 cursor-pointer">🗑️</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

