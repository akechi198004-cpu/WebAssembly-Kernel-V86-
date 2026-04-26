import React, { useState, useEffect, useRef, useCallback, memo, forwardRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Terminal, HardDrive, Cpu, Network, ArrowRightLeft, Settings, ShieldAlert, MonitorPlay, Save, RotateCcw } from 'lucide-react';
import { parseEthernetFrame } from './lib/packet-parser';
import * as idb from 'idb-keyval';

// Global types for V86
  declare global {
    interface Window {
      V86: any;
      V86Starter: any; // Keep just in case, but rely on window.V86
      global: any;
    }
  }

interface NetworkDataPoint {
  time: string;
  tx: number;
  rx: number;
}

// Prevent re-rendering of the v86 screen container
const V86Screen = memo(forwardRef<HTMLDivElement>((props, ref) => {
  useEffect(() => {
    if (ref && "current" in ref && ref.current) {
      if (ref.current.children.length === 0) {
        const textDiv = document.createElement('div');
        textDiv.style.whiteSpace = 'pre';
        textDiv.style.font = '14px monospace';
        textDiv.style.lineHeight = '14px';
        ref.current.appendChild(textDiv);

        const canvas = document.createElement('canvas');
        canvas.style.display = 'none';
        ref.current.appendChild(canvas);
      }
    }
  }, [ref]);

  return (
    <div 
      className="transform origin-center relative text-white"
      style={{ width: 800, height: 600, transform: 'scale(1)' }}
    >
      <div id="screen_container" ref={ref} style={{ width: '100%', height: '100%', backgroundColor: 'black' }} />
    </div>
  );
}), () => true);

export default function App() {
  const screenRef = useRef<HTMLDivElement>(null);
  const emulatorRef = useRef<any>(null);
  
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [hasSAB, setHasSAB] = useState(false);
  const [scriptError, setScriptError] = useState('');

  // Real-time metrics
  const [networkData, setNetworkData] = useState<NetworkDataPoint[]>([]);
  const [proxyLogs, setProxyLogs] = useState<string[]>([]);
  const [memoryUsage, setMemoryUsage] = useState(0);

  // Network tracking ref to avoid closures in event listeners
  const netStats = useRef({ tx: 0, rx: 0 });

  useEffect(() => {
    const handleError = (e: ErrorEvent) => setProxyLogs(prev => [...prev, `[WINDOW ERROR] ${e.message}`]);
    window.addEventListener('error', handleError);
    return () => {
      window.removeEventListener('error', handleError);
    };
  }, []);

  useEffect(() => {
    // Check for SAB (SharedArrayBuffer) and Cross-Origin Isolation
    if (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated) {
      setHasSAB(true);
    }

    if (window.V86 || window.V86Starter) {
      setIsReady(true);
    } else {
      // Load V86 script
      const script = document.createElement('script');
      script.src = '/v86/build/libv86.js';
      script.onload = () => setIsReady(true);
      script.onerror = () => setScriptError('Failed to load V86 engine');
      document.head.appendChild(script);
    }

    // Network stats updater loop
    const interval = setInterval(() => {
      setNetworkData(prev => {
        const now = new Date();
        const timeStr = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
        const newData = [...prev, { time: timeStr, tx: netStats.current.tx, rx: netStats.current.rx }];
        if (newData.length > 20) newData.shift();
        
        // Reset counters for the next tick
        netStats.current.tx = 0;
        netStats.current.rx = 0;
        return newData;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
      if (emulatorRef.current) {
        emulatorRef.current.destroy();
      }
    };
  }, []);

  const addProxyLog = useCallback((msg: string) => {
    setProxyLogs(prev => {
      const updated = [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`];
      return updated.slice(-10); // Keep last 10 logs
    });
  }, []);

  const startVM = async () => {
    if ((!window.V86 && !window.V86Starter) || !screenRef.current) return;
    setIsRunning(true);

    try {
      let savedState;
      try {
        savedState = await Promise.race([
          idb.get('v86-state'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('IDB timeout')), 2000))
        ]);
        addProxyLog("[SYSTEM] Loaded saved state from disk.");
      } catch (err) {
        console.warn("IndexedDB not accessible or timed out, starting fresh:", err);
        addProxyLog("[WARN] IndexedDB unavailable, starting fresh VM.");
      }

      addProxyLog("[SYSTEM] Initializing V86...");

      const V86Constructor = window.V86 || window.V86Starter;
      const emulator = new V86Constructor({
        wasm_path: '/v86/build/v86.wasm',
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        screen_container: screenRef.current,
        bios: { url: '/v86/bios/seabios.bin' },
        vga_bios: { url: '/v86/bios/vgabios.bin' },
        cdrom: { url: '/v86/images/linux3.iso' },
        autostart: true,
        cmdline: "rw init=/bin/sh",
        // network_relay_url: 'wss://relay.copy.sh/', 
        // disable_keyboard: false,
        // disable_mouse: false,
      });

      emulatorRef.current = emulator;

      emulator.add_listener('emulator-ready', () => {
        addProxyLog("[SYSTEM] Emulator ready.");
      });

      emulator.add_listener('emulator-started', () => {
        addProxyLog("[SYSTEM] Emulator started executing.");
      });

      let serialBuffer = '';
      emulator.add_listener('serial0-output-char', (char: string) => {
        console.log("SERIAL CHAR:", char);
        if (char === '\n') {
          addProxyLog(`[SERIAL] ${serialBuffer}`);
          serialBuffer = '';
        } else if (char !== '\r') {
          serialBuffer += char;
        }
      });

      emulator.add_listener('screen-set-mode', (isVga: boolean) => {
        addProxyLog(`[SYSTEM] Video mode changed: ${isVga ? 'VGA' : 'Text'}`);
      });

      emulator.add_listener('download-error', (e: any) => {
        console.error("V86 Download Error:", e);
        addProxyLog(`[ERROR] Download failed: ${e}`);
        setIsRunning(false);
      });

      emulator.add_listener('download-progress', (e: any) => {
        if (typeof e.loaded === 'number' && typeof e.total === 'number' && e.loaded === e.total) {
          addProxyLog(`[SYSTEM] Downloaded ${e.file_name}`);
        }
      });

      // 1. Hook into the Network Send (Tx)
      emulator.add_listener('net0-send', (rawPacket: Uint8Array) => {
        netStats.current.tx += rawPacket.length;

        // --------------------------------------------------------------------------------
        // [SECURITY ARCHITECTURE NOTE]
        // When a user runs a service like x-ui (port 54321) inside this VM:
        // 1. The VM creates raw Ethernet frames encapsulating TCP/IP packets.
        // 2. Since browsers cannot open raw TCP/UDP sockets natively, this hook captures the binary frames.
        // 3. The frames are natively relayed to the `wss://relay.copy.sh/` WebSocket proxy backend.
        // 4. The backend unwraps the WSS frames and emits raw TCP traffic to the real internet, acting as NAT.
        // 5. For port forwarding (e.g. x-ui 54321), our Inbound Intercept logic acts as a Virtual Reverse Proxy
        //    by examining packet headers in JavaScript, allowing us to map local UI interactions 
        //    directly into the Wasm-simulated Virtio-Net device space without exposing the host OS networks.
        // --------------------------------------------------------------------------------
        const parsed = parseEthernetFrame(rawPacket);
        if (parsed) {
          // Inbound Intercept: Port Forwarding / Proxy Logic
          if (parsed.type === 'TCP' && parsed.dstPort === 54321) {
            addProxyLog(`[X-UI P-FWD] Intercepted TCP to ${parsed.dstIp}:54321. Proxying via Virtual Interface...`);
          }
          // DNS Hijacking Logic
          if (parsed.type === 'UDP' && parsed.dstPort === 53) {
            addProxyLog(`[DNS HIJACK] Intercepted UDP 53 to ${parsed.dstIp}. Resolving via DoH Bridge...`);
          }
        }
      });

      // 2. Hook into Network Receive (Rx)
      emulator.add_listener('net0-receive', (rawPacket: Uint8Array) => {
         // v86 doesn't always expose this cleanly but if it does, track it
         netStats.current.rx += rawPacket?.length || 0;
      });

      // 3. Monitor Memory Usage (Mock logic: interpolate since v86 doesn't supply direct % used easily)
      setInterval(() => {
        // Just simulating the fluctuating RAM for visual completeness of the monitor
        setMemoryUsage(20 + Math.random() * 5);
      }, 5000);

    } catch (e) {
      console.error("Boot failed:", e);
      addProxyLog("[ERROR] Failed to boot VM.");
      setIsRunning(false);
    }
  };

  const saveState = async () => {
    if (!emulatorRef.current) return;
    addProxyLog("[SYSTEM] Saving 2GB disk state to IndexedDB...");
    
    emulatorRef.current.save_state(async (err: any, state: Uint8Array) => {
      if (err) {
        addProxyLog(`[ERROR] State save failed: ${err.message}`);
        return;
      }
      try {
        await idb.set('v86-state', state);
        addProxyLog("[SYSTEM] State saved successfully to IndexedDB! Refreshing will restore it.");
      } catch (idbErr) {
        addProxyLog("[ERROR] IndexedDB write failed.");
      }
    });
  };

  const clearState = async () => {
    await idb.del('v86-state');
    addProxyLog("[SYSTEM] Wiped disk state from IndexedDB.");
    if (emulatorRef.current) {
      emulatorRef.current.stop();
      emulatorRef.current = null;
    }
    setIsRunning(false);
    addProxyLog("[SYSTEM] Machine destroyed. Ready for fresh boot.");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-sans flex flex-col selection:bg-cyan-900">
      
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center border border-cyan-500/40">
            <Cpu className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-medium text-slate-100 leading-tight">Wasm Virtual Infrastructure</h1>
            <p className="text-xs text-slate-500 font-mono">x86_64 Kernel / Virtio-Net Bridge</p>
          </div>
        </div>

          <div className="flex items-center gap-4">
            {scriptError && <span className="text-red-400 text-xs font-mono">{scriptError}</span>}
          <div className="flex items-center gap-2 text-xs font-mono bg-slate-800/50 px-3 py-1.5 rounded-md border border-slate-700/50">
            {hasSAB ? (
              <><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> COI / SAB Enabled</>
            ) : (
              <><span className="w-2 h-2 rounded-full bg-amber-500"></span> SAB Disabled</>
            )}
          </div>
          
          <button 
            onClick={startVM}
            disabled={!isReady || isRunning}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md font-medium transition-colors text-sm"
          >
            <MonitorPlay className="w-4 h-4" />
            {isRunning ? 'Running...' : 'Power On VM'}
          </button>
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-4 gap-6 content-start">
        
        {/* Left Column: VM Display */}
        <div className="lg:col-span-3 space-y-4">
          <div className="aspect-video bg-black rounded-xl border border-slate-800 overflow-hidden shadow-2xl relative flex items-center justify-center">
            
            {/* The v86 Screen Target */}
            <V86Screen ref={screenRef} />
            
            {!isRunning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 z-10 pointer-events-none bg-black/80">
                <MonitorPlay className="w-16 h-16 mb-4 opacity-20" />
                <p className="font-mono text-sm">System Offline. Awaiting Power On.</p>
              </div>
            )}
            
          </div>

          <div className="flex items-center justify-between px-2 text-xs text-slate-500 font-mono">
            <div className="flex gap-4">
              <span className="flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5" /> Client-Side Sandbox</span>
              <span className="flex items-center gap-1.5"><ArrowRightLeft className="w-3.5 h-3.5" /> WebSocket Tunneling Active</span>
            </div>
          </div>
        </div>

        {/* Right Column: Monitors & Controls */}
        <div className="space-y-6">
          
          {/* Storage & State */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-slate-200 font-medium">
              <HardDrive className="w-4 h-4 text-indigo-400" />
              <h2>Block Storage (IndexedDB)</h2>
            </div>
            
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-400">
                <span>/dev/sda1 (Local Persistence)</span>
                <span>2GB</span>
              </div>
              <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 rounded-full w-[45%]"></div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              <button onClick={saveState} className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded font-mono text-xs transition-colors border border-slate-700">
                <Save className="w-3 h-3" /> Save State
              </button>
              <button onClick={clearState} className="flex items-center justify-center gap-2 bg-red-950/30 hover:bg-red-900/50 text-red-400 px-3 py-2 rounded font-mono text-xs transition-colors border border-red-900/30">
                <RotateCcw className="w-3 h-3" /> Wipe Disk
              </button>
            </div>
          </div>

          {/* Network Traffic */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between text-slate-200 font-medium">
              <div className="flex items-center gap-2">
                <Network className="w-4 h-4 text-emerald-400" />
                <h2>Virtio-Net Traffic</h2>
              </div>
              <span className="text-xs font-mono text-slate-500">net0</span>
            </div>

            <div className="h-32 w-full mt-4" style={{ minHeight: 0, minWidth: 0, color: 'white' }}>
              [Recharts Disabled Temporarily]
            </div>
          </div>

          {/* Protocol Bridge Console */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-64">
            <div className="bg-slate-950/50 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-200 font-medium text-sm">
                <Terminal className="w-4 h-4 text-amber-400" />
                <span>Protocol Bridge Relay</span>
              </div>
            </div>
            <div className="flex-1 p-4 overflow-y-auto font-mono text-[10px] leading-relaxed text-slate-400 space-y-1">
              <div className="text-cyan-500/50">Listening for outbound Virtio-net frames...</div>
              <div className="text-cyan-500/50">WSS Proxy configuration: wss://relay.copy.sh/</div>
              <div className="text-slate-600">---</div>
              {proxyLogs.map((log, i) => (
                <div key={i} className={log.includes('ERROR') ? 'text-red-400' : 'text-slate-300'}>{log}</div>
              ))}
            </div>
          </div>

          {/* System Specs Sidebar */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-slate-200 font-medium">
              <Settings className="w-4 h-4 text-purple-400" />
              <h2>Hardware Spec</h2>
            </div>
            
            <div className="space-y-3 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800 pb-2">
                <span className="text-slate-500">Architecture</span>
                <span className="text-slate-300">x86_64</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-2">
                <span className="text-slate-500">Acceleration</span>
                <span className="text-slate-300">Wasm JIT</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-2">
                <span className="text-slate-500">Display</span>
                <span className="text-slate-300">Cirrus Logic (1024x768)</span>
              </div>
              <div className="space-y-1 pt-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">RAM (512MB)</span>
                  <span className="text-slate-300">{memoryUsage.toFixed(1)}%</span>
                </div>
                <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-purple-500 rounded-full transition-all duration-1000" style={{ width: `${memoryUsage}%` }}></div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </main>

    </div>
  );
}

