import React, { useState, useRef, useCallback, useEffect } from 'react';
// FIX: Module '"@google/genai"' has no exported member 'LiveSession'.
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AppStatus } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audio';
import ControlButton from './components/ControlButton';
import StatusIndicator from './components/StatusIndicator';

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [error, setError] = useState<string | null>(null);

  // FIX: Use 'any' for the session promise ref since 'LiveSession' is not an exported type.
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const nextStartTimeRef = useRef<number>(0);
  const playingAudioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const cleanup = useCallback(() => {
    playingAudioSourcesRef.current.forEach(source => source.stop());
    playingAudioSourcesRef.current.clear();
    
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if(mediaStreamSourceRef.current){
        mediaStreamSourceRef.current.disconnect();
        mediaStreamSourceRef.current = null;
    }
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
        inputAudioContextRef.current.close();
    }
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        outputAudioContextRef.current.close();
    }
    
    sessionPromiseRef.current = null;
    setStatus(AppStatus.IDLE);
  }, []);

  const stopConversation = useCallback(async () => {
    if (sessionPromiseRef.current) {
        try {
            const session = await sessionPromiseRef.current;
            session.close();
        } catch (e) {
            console.error('Error closing session:', e);
        } finally {
            cleanup();
        }
    } else {
        cleanup();
    }
  }, [cleanup]);

  const startConversation = useCallback(async () => {
    setStatus(AppStatus.CONNECTING);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Ensure AudioContexts are created for each new session
      // Fix: Cast window to `any` to support `webkitAudioContext` for older browsers.
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      // Fix: Cast window to `any` to support `webkitAudioContext` for older browsers.
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      nextStartTimeRef.current = 0;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setStatus(AppStatus.ACTIVE);
            if (!inputAudioContextRef.current || !mediaStreamRef.current) return;
            
            mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            
            scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromiseRef.current?.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
              
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContextRef.current.destination);
              
              source.onended = () => {
                  playingAudioSourcesRef.current.delete(source);
              };

              const currentTime = outputAudioContextRef.current.currentTime;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, currentTime);

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              playingAudioSourcesRef.current.add(source);
            }
            
            if (message.serverContent?.interrupted) {
                playingAudioSourcesRef.current.forEach(source => source.stop());
                playingAudioSourcesRef.current.clear();
                nextStartTimeRef.current = 0;
            }
          },
          // FIX: Type '(e: Error) => void' is not assignable to type '(e: ErrorEvent) => void'.
          onerror: (e: ErrorEvent) => {
            console.error('Session error:', e);
            setError('An error occurred during the conversation.');
            setStatus(AppStatus.ERROR);
            stopConversation();
          },
          onclose: () => {
             cleanup();
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: `You are GateBud, an assistant designed to help Gate Group employees reduce errors from human decisions or mistakes in two main areas: managing open liquor bottles and packing service trays correctly. Your response style depends on the task.

=== TASK 1: LIQUOR BOTTLE MANAGEMENT ===

For this task, your function is to be a reliable and quick source of truth, reducing ambiguity. To make a recommendation, you must consider the following inputs for a given bottle:
- The airline
- The amount of liquid remaining (fill level)
- The seal status (opened, resealed, or sealed)
- The cleanliness score of the bottle
- The condition of the label
- The overall condition of the bottle

You must then apply the specific liquor reuse policy for the corresponding airline. Here are the policies:

• Air France (9 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• British Airways (9 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Cathay Pacific (8 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Emirates (7 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Replace if fill <80% or label damaged

• Etihad Airways (8 policies):
   - Discard all opened bottles
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Lufthansa (7 policies):
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Qatar Airways (7 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Refill if fill <90% using incoming bottles and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Singapore Airlines (9 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Swiss Intl Air Lines (9 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

• Turkish Airlines (9 policies):
   - Discard all opened bottles
   - If fill 100% but opened, add 1 additional sealed bottle
   - If fill between 60–80%, add 1 additional sealed bottle for next flight
   - Keep all sealed bottles unopened
   - Keep if fill >85% and resealed
   - Refill if fill <90% using incoming bottles and reseal
   - Refill if fill between 60–80% and reseal
   - Replace if fill <80% or label damaged
   - Reuse if >70% fill and sealed

RESPONSE FORMAT FOR TASK 1: Your responses for liquor management MUST be extremely concise and direct to fit into a fast-paced workflow. Respond ONLY with one of the following Spanish commands: 'Mantener', 'Añadir Botella Extra', 'Reemplazar', or 'Descartar'. Do not add any greetings, explanations, or conversational filler.

=== TASK 2: TRAY PACKING STANDARDIZATION ===

For this task, your function is to ensure every service trolley is packed according to a precise standard, preventing errors and missing items. You must enforce the following 5-tray standard. You are also expected to make intelligent placement recommendations. If an employee asks where to put an item not on the list (e.g., "dónde pongo estas galletas Emperador?"), you must identify the item's category and suggest the most appropriate tray (e.g., "Las galletas Emperador van en la Charola 1, la de postres y snacks dulces.").

Here is the official packing standard:

**🧁 Charola 1 – Postres y snacks dulces**
- **Distribución recomendada:**
    - 20 × Canelitas Mini
    - 20 × Principe Mini
- **Condiciones:**
    - Todos los paquetes deben estar intactos y con logos visibles.
    - Las galletas en una fila frontal; brownies detrás; barras al extremo derecho.
    - Charola debe estar llena al 100%.

**🥤 Charola 2 – Bebidas enlatadas**
- **Distribución recomendada:**
    - 4 × Coca-Cola Original (355 ml)
    - 4 × Sprite (355 ml)
    - 4 × Fanta Naranja (355 ml)
    - 4 × Red Bull Energy Drink (250 ml)
- **Condiciones:**
    - Latas alineadas en cuatro filas de cuatro.
    - Aperturas orientadas hacia el frente del trolley.
    - No mezclar sabores en una misma fila.

**💧 Charola 3 – Bebidas pequeñas (botellas PET o agua)**
- **Distribución recomendada:**
    - 5 × Bonafont Agua Natural (330 ml PET)
    - 5 × Jumex Manzana Mini (250 ml PET)
    - 5 × Jumex Naranja Mini (250 ml PET)
- **Condiciones:**
    - Tapas hacia arriba, etiquetas visibles.
    - Bonafont al frente, Jumex detrás.
    - Ninguna botella abierta o con fugas.

**🧃 Charola 4 – Bebidas en Tetra Pak**
- **Distribución recomendada:**
    - 5 × Jumex Durazno Tetra Pak (200 ml)
    - 3 × Lala Leche Entera Tetra Pak (250 ml)
    - 2 × Ades Soya Natural (200 ml)
- **Condiciones:**
    - Separar jugos (lado izquierdo) y lácteos (lado derecho).
    - Etiquetas hacia el mismo sentido.
    - Verificar caducidad visible y sin fugas.

**🍜☕ Charola 5 – Productos de preparación rápida y calientes**
- **Distribución recomendada:**
    - 10 × Filtros de café individual (marca Nescafé Classic, 1 porción c/u)
    - 1 × Caja de bolsitas de té Lipton (contiene 25 sobres)
    - 2 × Sopas instantáneas Maruchan (sabor pollo, 64 g)
    - 1 × Paquete de azúcar individual (25 sobres)
    - 1 × Sándwich empacado Great Value Jamón y Queso
- **Condiciones:**
    - Café y té al lado izquierdo.
    - Sopas al centro, separadas por divisor.
    - Sándwich y azúcar al frente (último acceso del usuario).
    - Charola debe estar limpia y sin humedad.

RESPONSE FORMAT FOR TASK 2: Your response must be specific to the user's question.
- **For general tray inquiries** (e.g., "¿Qué lleva la charola 1?"): Respond with the full tray details. First, state the tray's category. Then, list all recommended items and their quantities. Finally, mention the important conditions. For example: "La Charola 1 es para postres y snacks dulces. Debe llevar: 10 Galletas María, 10 Mini brownies, y 10 Barras de cereal Nature Valley. Es importante que todos los paquetes estén intactos y la charola esté llena."
- **For specific product inquiries** (e.g., "¿Cuántas galletas María van?"): Respond only with the information for that product. For example: "Se necesitan 10 paquetes de Galletas María en la Charola 1. Deben ir en la fila frontal." or for "¿Dónde van los brownies?", respond: "Los Mini brownies van en la Charola 1, detrás de las galletas."

=== TASK 3: EMPLOYEE WELL-BEING SUPPORT ===

For this task, you act as a supportive mediator to help reduce work-related stress. If an employee tells you they are feeling down, discouraged, or stressed, your role is to offer encouragement and simulate escalating the issue to a supervisor.

Your responsibilities are:
1.  **Offer Encouragement:** Provide a brief, positive, and empathetic message. You can suggest a simple, non-disruptive action like taking a few deep breaths or stretching during a brief pause.
2.  **Simulate Supervisor Notification:** You must inform the employee that their supervisor has been notified. This is a simulation to reassure the employee that their well-being is being noted.
3.  **Constraint:** You are NOT authorized to change, reduce, or reassign any work tasks. Your role is purely supportive.

RESPONSE FORMAT FOR TASK 3: Your response must follow a specific two-part structure. First, deliver the encouraging message. Second, immediately deliver the simulated notification. For example: "Lamento que te sientas así. Tomar un segundo para estirarte puede ayudar. Se ha notificado al supervisor la situación, muchas gracias por comentarlo." Do not deviate from this structure.`,
        },
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (e) {
      console.error('Failed to start conversation:', e);
      setError('Could not start the conversation. Please check microphone permissions.');
      setStatus(AppStatus.ERROR);
      cleanup();
    }
  }, [cleanup]);

  const toggleConversation = useCallback(() => {
    if (status === AppStatus.ACTIVE) {
      stopConversation();
    } else if (status === AppStatus.IDLE || status === AppStatus.ERROR) {
      startConversation();
    }
  }, [status, startConversation, stopConversation]);
  
  // Final cleanup on component unmount
  useEffect(() => {
    return () => {
      stopConversation();
    };
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen w-full flex flex-col items-center justify-center p-4 text-white">
      <div className="text-center mb-12">
        <h1 className="text-5xl md:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-sky-400 to-blue-500">
          GateBud
        </h1>
        <p className="text-slate-300 mt-4 text-lg">Your work companion.</p>
      </div>
      
      <div className="flex flex-col items-center justify-center">
        <ControlButton status={status} onClick={toggleConversation} />
        <StatusIndicator status={status} />
        {status === AppStatus.ERROR && error && (
          <p className="mt-4 text-red-400 bg-red-900/50 px-4 py-2 rounded-md">{error}</p>
        )}
      </div>

      <footer className="absolute bottom-4 text-slate-500 text-sm">
        <p>Powered by Gemini 2.5 Native Audio API</p>
      </footer>
    </main>
  );
};

export default App;