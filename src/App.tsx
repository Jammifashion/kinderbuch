/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import { db, auth, storage } from './lib/firebase';
import { collection, addDoc, serverTimestamp, getDocs, updateDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';

// --- Initialization ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL_NAME = 'gemini-3.1-flash-lite';
const IMAGE_MODEL = 'gemini-2.5-flash-image';
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
  const [isDevMode, setIsDevMode] = useState(false);
  const [idea, setIdea] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [result, setResult] = useState<StoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (authUser) => {
      setUser(authUser);
    });
  }, []);

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
        <button onClick={handleDevLogin} className="text-xs text-stone-400 hover:text-orange-500 underline">
          Entwickler-Login (Lokal)
        </button>
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
        setResult({ ...storyData, id: docRef.id });
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

  const generateCharacterImage = async () => {
    if (!result) return;
    setIsImageLoading(true);
    setError(null);
    try {
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: {
          parts: [{ text: result.hauptcharakter.bild_prompt_en }],
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
      
      {/* ... (rest of the UI, modified to add image generation button) */}
      <main className="mx-auto max-w-3xl">
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
                <div key={i} className="cursor-pointer rounded-2xl bg-white border-2 border-slate-100 p-4 text-center font-bold text-slate-700 transition hover:border-orange-200 hover:shadow-sm">
                  {titel}
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
      </main>
    </div>
  );
}

