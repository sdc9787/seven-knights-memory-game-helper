/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Monitor, RefreshCw, Grid3X3, Play, Pause, Image as ImageIcon, MousePointer2, MonitorPlay, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants ---
const ROWS = 3;
const COLS = 8;
const TOTAL_CARDS = ROWS * COLS;
const DETECTION_SIZE = 10;
const CAPTURE_DELAY_MS = 200; // 60fps 환경에서 더 빠르게 낚아채기 위해 단축
const RESET_PERSISTENCE_FRAMES = 60; // 60fps 기준 약 1초 유지

// 제공된 뒷면 이미지의 평균 밝기 근사치
const REFERENCE_BACK_BRIGHTNESS = 52;
const DEFAULT_RECT = { x: 45, y: 76, w: 507, h: 254, gapX: 14, gapY: 10, offsetX: -6, offsetY: 27, detectionSize: 6 };

interface CardState {
  id: number;
  image: string | null;
  isFlipped: boolean;
  isCapturing: boolean;
  detectedAt: number | null;
  rect: { x: number, y: number, w: number, h: number } | null;
  baselineBrightness: number | null; // 뒷면 상태의 기준 밝기
}

interface SelectionRect {
  startX: number;
  startY: number;
  width: number;
  height: number;
}

export default function App() {
  // --- State ---
  const [cards, setCards] = useState<CardState[]>(
    Array.from({ length: TOTAL_CARDS }, (_, i) => ({
      id: i,
      image: null,
      isFlipped: false,
      isCapturing: false,
      detectedAt: null,
      rect: null,
      baselineBrightness: null,
    }))
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pauseDuration, setPauseDuration] = useState(1000);
  const [sensitivity, setSensitivity] = useState(10); // 감지 민감도 (%)
  const [overlayThreshold, setOverlayThreshold] = useState(5); // 오버레이 감지 임계값

  const pauseDurationRef = useRef(pauseDuration);
  const sensitivityRef = useRef(sensitivity);
  const overlayThresholdRef = useRef(overlayThreshold);

  useEffect(() => { pauseDurationRef.current = pauseDuration; }, [pauseDuration]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { overlayThresholdRef.current = overlayThreshold; }, [overlayThreshold]);

  const isPausedRef = useRef(false);
  const gameStartTimeRef = useRef<number>(0); // 게임 시작(START 문구) 시점 기록
  const pauseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [logs, setLogs] = useState<string[]>(['시스템 준비 완료. 시작 버튼을 눌러주세요.']);
  const [fps, setFps] = useState(0);
  const fpsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const frameCountRef = useRef(0);

  const addLog = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 50));
  };

  // Selection State
  const [selection, setSelection] = useState<SelectionRect | null>({
    startX: DEFAULT_RECT.x,
    startY: DEFAULT_RECT.y,
    width: DEFAULT_RECT.w,
    height: DEFAULT_RECT.h
  });
  const [manualRect, setManualRect] = useState(DEFAULT_RECT);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number, y: number } | null>(null);
  const [currentDrag, setCurrentDrag] = useState<{ x: number, y: number } | null>(null);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number | null>(null);
  const lastFrameTime = useRef<number>(0);
  const cardsRef = useRef<CardState[]>([]);
  const resetCounterRef = useRef<number>(0);
  const backResetCounterRef = useRef<number>(0);
  const vOffsetXRef = useRef(0);
  const vOffsetYRef = useRef(0);
  const pipCanvasRef = useRef<HTMLCanvasElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const [isPipActive, setIsPipActive] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [isSettingsCollapsed, setIsSettingsCollapsed] = useState(true);
  const cardImagesRef = useRef<Map<number, HTMLImageElement>>(new Map());

  // PiP Canvas Update Logic
  const updatePipCanvas = useCallback(() => {
    if (!pipCanvasRef.current) return;
    const canvas = pipCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cardW = canvas.width / COLS;
    const cardH = canvas.height / ROWS;

    cardsRef.current.forEach((card, i) => {
      const r = Math.floor(i / COLS);
      const c = i % COLS;
      const x = c * cardW;
      const y = r * cardH;

      ctx.fillStyle = card.isCapturing ? '#f9731622' : (card.image ? '#27272a' : '#18181b');
      ctx.fillRect(x + 2, y + 2, cardW - 4, cardH - 4);

      ctx.strokeStyle = card.isCapturing ? '#f97316' : (card.image ? '#3f3f46' : '#27272a');
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 2, y + 2, cardW - 4, cardH - 4);

      if (card.image) {
        let img = cardImagesRef.current.get(card.id);
        if (!img || img.src !== card.image) {
          img = new Image();
          img.src = card.image;
          cardImagesRef.current.set(card.id, img);
        }
        if (img.complete) {
          ctx.drawImage(img, x + 4, y + 4, cardW - 8, cardH - 8);
        }
      }

      ctx.fillStyle = '#52525b';
      ctx.font = 'bold 10px monospace';
      ctx.fillText((i + 1).toString(), x + 6, y + 14);

      if (card.isFlipped) {
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(x + cardW - 10, y + 10, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  }, []);

  useEffect(() => {
    if (isPipActive) {
      updatePipCanvas();
    }
  }, [cards, isPipActive, updatePipCanvas]);

  const togglePip = async () => {
    if (!pipVideoRef.current || !pipCanvasRef.current) return;
    const video = pipVideoRef.current;

    if (isPipActive) {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
      setIsPipActive(false);
    } else {
      try {
        updatePipCanvas();
        const stream = pipCanvasRef.current.captureStream(10);
        video.srcObject = stream;
        await video.play();
        await video.requestPictureInPicture();
        setIsPipActive(true);
        addLog('PiP 모드가 활성화되었습니다. 게임 화면 위에 띄워두고 플레이하세요.');

        video.addEventListener('leavepictureinpicture', () => {
          setIsPipActive(false);
        }, { once: true });
      } catch (err) {
        console.error('PiP failed:', err);
        addLog('PiP 모드 시작에 실패했습니다. 브라우저 지원 여부를 확인해주세요.');
      }
    }
  };

  const UsageModal = () => (
    <AnimatePresence>
      {showUsage && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-lg w-full shadow-2xl space-y-6"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Monitor className="w-5 h-5 text-orange-500" />
                사용법 가이드
              </h2>
            </div>

            <div className="space-y-6 overflow-y-auto max-h-[60vh] pr-2 scrollbar-hide">
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-zinc-300 uppercase flex items-center gap-2">
                  <Play className="w-4 h-4 text-orange-400" />
                  시작 가이드
                </h3>
                <div className="p-4 rounded-xl bg-zinc-950/50 border border-zinc-800/50">
                  <p className="text-xs text-zinc-400 leading-relaxed space-y-2">
                    1. 세븐나이츠 리버스 클라이언트를 <span className="text-zinc-200 font-bold">창모드</span>로 실행합니다.<br />
                    2. <span className="text-zinc-200 font-bold">'시작'</span> 버튼을 눌러 <span className="text-zinc-200 font-bold">창 -&gt; 세븐나이츠 리버스</span>를 선택합니다.<br />
                    3. 게임 내에서 미니게임을 시작합니다.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-bold text-zinc-300 uppercase flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-blue-400" />
                  주의 사항
                </h3>
                <div className="p-4 rounded-xl bg-zinc-950/50 border border-zinc-800/50">
                  <p className="text-xs text-zinc-400 leading-relaxed space-y-2">
                    1. 기본 설정값은 최적의 인식 값이므로 가급적 변경하지 마세요.<br />
                    2. 본 사이트는 <span className="text-zinc-200 font-bold">크롬(Chrome)</span> 브라우저에 최적화되어 있습니다.<br />
                    3. 카드 영역 레이아웃이 사라지면 <span className="text-zinc-200 font-bold">'좌표 적용'</span> 버튼을 눌러주세요.<br />
                    4. 실시간 화면 분석은 PC 자원을 소모하므로, 프레임 드랍이나 렉 발생 시 카드 인식이 원활하지 않을 수 있습니다.<br />
                    5. 마우스 포인터가 카드를 가리면 인식이 방해될 수 있으므로, 마우스를 카드 영역 밖으로 치워주세요.
                  </p>
                </div>
              </div>

              <div className="pt-2 border-t border-zinc-800/50">
                <p className="text-[10px] text-zinc-500 text-center italic">
                  ※ 본 사이트 이용으로 발생한 어떠한 손해에 대해서도 책임을 지지 않습니다.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowUsage(false)}
              className="w-full py-3 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded-xl shadow-lg shadow-orange-900/20 transition-all"
            >
              확인했습니다
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
  const detectionSizeRef = useRef(DEFAULT_RECT.detectionSize);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // --- Optimized Pixel Detection (Single Buffer) ---
  const getBrightnessFromPixels = (pixels: Uint8ClampedArray, rect: { x: number, y: number, w: number, h: number }, canvasW: number, canvasH: number, vOffX: number = 0, vOffY: number = 0) => {
    const centerX = Math.floor(rect.x + rect.w / 2 + vOffX);
    const centerY = Math.floor(rect.y + rect.h / 2 + vOffY);

    const dSize = detectionSizeRef.current;
    const startX = Math.max(0, centerX - Math.floor(dSize / 2));
    const startY = Math.max(0, centerY - Math.floor(dSize / 2));

    let brightnessSum = 0;
    let count = 0;
    for (let y = startY; y < startY + dSize && y < canvasH; y++) {
      for (let x = startX; x < startX + dSize && x < canvasW; x++) {
        const idx = (y * canvasW + x) * 4;
        if (idx + 2 < pixels.length) {
          brightnessSum += (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
          count++;
        }
      }
    }
    return count > 0 ? brightnessSum / count : 0;
  };

  // --- Grid Calculation from Selection ---
  const updateGridFromSelection = useCallback((sel: SelectionRect, gapX: number = 0, gapY: number = 0, offX: number = 0, offY: number = 0, dSize: number = 10) => {
    if (!videoRef.current) return;

    const video = videoRef.current;
    const container = containerRef.current;
    if (!container) return;

    // Map UI coordinates to Video coordinates
    const rect = container.getBoundingClientRect();
    const scaleX = video.videoWidth / rect.width;
    const scaleY = video.videoHeight / rect.height;

    const vX = sel.startX * scaleX;
    const vY = sel.startY * scaleY;
    const vW = sel.width * scaleX;
    const vH = sel.height * scaleY;
    const vGapX = gapX * scaleX;
    const vGapY = gapY * scaleY;

    vOffsetXRef.current = offX * scaleX;
    vOffsetYRef.current = offY * scaleY;
    detectionSizeRef.current = dSize;

    // Calculate individual card size accounting for gaps
    // Total Width = COLS * cardWidth + (COLS - 1) * gapX
    const cellW = (vW - (COLS - 1) * vGapX) / COLS;
    const cellH = (vH - (ROWS - 1) * vGapY) / ROWS;

    setCards(prev => prev.map((card, i) => {
      const r = Math.floor(i / COLS);
      const c = i % COLS;
      const cardRect = {
        x: vX + c * (cellW + vGapX),
        y: vY + r * (cellH + vGapY),
        w: cellW,
        h: cellH
      };

      // 제공된 레퍼런스 이미지 밝기를 기본값으로 사용
      return {
        ...card,
        rect: cardRect,
        baselineBrightness: REFERENCE_BACK_BRIGHTNESS
      };
    }));
    addLog('그리드 설정 및 레퍼런스 이미지 기준 보정이 완료되었습니다.');
  }, []);

  // --- Recalibrate Baseline ---
  const recalibrateBaseline = useCallback(() => {
    if (!canvasRef.current || !isStreaming) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const fullData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = fullData.data;

    setCards(prev => prev.map(card => {
      if (!card.rect) return card;
      const baseline = getBrightnessFromPixels(pixels, card.rect, canvas.width, canvas.height, vOffsetXRef.current, vOffsetYRef.current);
      return { ...card, baselineBrightness: baseline };
    }));
    addLog('현재 화면을 기준으로 밝기 기준점을 재설정했습니다.');
  }, [isStreaming]);
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isStreaming || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setDragStart({ x, y });
    setCurrentDrag({ x, y });
    setIsDragging(true);
    setSelection(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCurrentDrag({ x, y });
  };

  const handleMouseUp = () => {
    if (!isDragging || !dragStart || !currentDrag) return;

    const startX = Math.min(dragStart.x, currentDrag.x);
    const startY = Math.min(dragStart.y, currentDrag.y);
    const width = Math.abs(currentDrag.x - dragStart.x);
    const height = Math.abs(currentDrag.y - dragStart.y);

    if (width > 20 && height > 20) {
      const newSelection = { startX, startY, width, height };
      setSelection(newSelection);
      setManualRect({
        x: Math.round(startX),
        y: Math.round(startY),
        w: Math.round(width),
        h: Math.round(height),
        gapX: manualRect.gapX,
        gapY: manualRect.gapY,
        offsetX: manualRect.offsetX,
        offsetY: manualRect.offsetY,
        detectionSize: manualRect.detectionSize
      });
      updateGridFromSelection(newSelection, manualRect.gapX, manualRect.gapY, manualRect.offsetX, manualRect.offsetY, manualRect.detectionSize);
    }

    setIsDragging(false);
    setDragStart(null);
    setCurrentDrag(null);
  };

  // --- Manual Coordinate Apply ---
  const applyManualRect = () => {
    const newSelection = {
      startX: manualRect.x,
      startY: manualRect.y,
      width: manualRect.w,
      height: manualRect.h
    };
    setSelection(newSelection);
    updateGridFromSelection(newSelection, manualRect.gapX, manualRect.gapY, manualRect.offsetX, manualRect.offsetY, manualRect.detectionSize);
    addLog(`수동 좌표 적용: X=${manualRect.x}, Y=${manualRect.y}, W=${manualRect.w}, H=${manualRect.h}, GapX=${manualRect.gapX}, GapY=${manualRect.gapY}, OffX=${manualRect.offsetX}, OffY=${manualRect.offsetY}, Size=${manualRect.detectionSize}`);
  };

  // --- Frame Processing Loop ---
  const processFrame = useCallback((time: number) => {
    if (!videoRef.current || !canvasRef.current || !isStreaming) return;

    // 프레임 제한 해제 (최대한 빠르게)
    lastFrameTime.current = time;

    if (isPausedRef.current) {
      requestRef.current = requestAnimationFrame(processFrame);
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frameCountRef.current++;

    // 단 한 번의 호출로 전체 픽셀 데이터 획득 (성능 핵심)
    const fullData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = fullData.data;

    const currentCards = cardsRef.current;
    let flippedCount = 0;
    let newlyFlippedCount = 0;
    let hasChanges = false;
    const nextCards = [...currentCards];

    for (let i = 0; i < currentCards.length; i++) {
      const card = currentCards[i];
      if (!card.rect) continue;

      const brightness = getBrightnessFromPixels(pixels, card.rect, canvas.width, canvas.height, vOffsetXRef.current, vOffsetYRef.current);
      const baseline = card.baselineBrightness || REFERENCE_BACK_BRIGHTNESS;

      // 설정된 민감도에 따라 판정
      const threshold = 1 - (sensitivityRef.current / 100);
      const backThreshold = 1 - (sensitivityRef.current / 200); // 복귀는 좀 더 완만하게

      let isCurrentlyFlipped = card.isFlipped;
      if (!card.isFlipped && brightness < baseline * threshold) {
        isCurrentlyFlipped = true;
      } else if (card.isFlipped && brightness > baseline * backThreshold) {
        isCurrentlyFlipped = false;
      }

      if (isCurrentlyFlipped) flippedCount++;

      // A. State Change Detection (Hysteresis)
      if (isCurrentlyFlipped !== card.isFlipped) {
        nextCards[i] = { ...nextCards[i], isFlipped: isCurrentlyFlipped };
        hasChanges = true;

        // If it just flipped up, count it for overlay detection
        if (isCurrentlyFlipped) {
          newlyFlippedCount++;

          // If we don't have an image, start capturing
          if (!card.image && !card.isCapturing) {
            nextCards[i].isCapturing = true;
            nextCards[i].detectedAt = Date.now();
          }
        }
      }

      // B. Independent Capture Logic (Runs even if card flips back)
      if (card.isCapturing && card.detectedAt) {
        if (Date.now() - card.detectedAt! >= CAPTURE_DELAY_MS) {
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = card.rect.w;
          cropCanvas.height = card.rect.h;
          const cropCtx = cropCanvas.getContext('2d');
          if (cropCtx) {
            cropCtx.drawImage(canvas, card.rect.x, card.rect.y, card.rect.w, card.rect.h, 0, 0, card.rect.w, card.rect.h);
            const base64 = cropCanvas.toDataURL('image/png');
            nextCards[i] = { ...nextCards[i], image: base64, isCapturing: false, detectedAt: null };
            hasChanges = true;
            addLog(`${i + 1}번 카드 이미지 기록 완료.`);
          }
        }
      }
    }

    // 2. Global Overlay Detection (e.g., "START" text)
    // 설정된 임계값 이상의 카드가 동시에 변하면 오버레이로 판단
    if (newlyFlippedCount >= overlayThresholdRef.current) {
      isPausedRef.current = true;
      setIsPaused(true);
      gameStartTimeRef.current = Date.now(); // 게임 시작(START 문구) 시점 기록 (초기화 보호 시작)

      if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
      pauseTimeoutRef.current = setTimeout(() => {
        isPausedRef.current = false;
        setIsPaused(false);
        addLog("감지를 재개합니다.");
      }, pauseDurationRef.current);

      // 화면 전체 변화(START) 시 그리드 초기화 (이미지가 있는 경우에만 로그 출력)
      const hasAnyImage = currentCards.some(c => c.image !== null);
      const resetCards = currentCards.map(c => ({
        ...c,
        image: null,
        isFlipped: false,
        isCapturing: false,
        detectedAt: null
      }));
      setCards(resetCards);

      if (hasAnyImage) {
        addLog(`화면 전체 변화 감지 (${newlyFlippedCount}개). 그리드를 초기화하고 ${pauseDurationRef.current}ms간 감지를 중단합니다.`);
      } else {
        addLog(`화면 전체 변화 감지 (${newlyFlippedCount}개). ${pauseDurationRef.current}ms간 감지를 중단합니다.`);
      }

      requestRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // 3. Reset Logic: Clear all when ALL cards are face up (end of game)
    // 안정성을 위해 일정 프레임 이상 유지될 때만 초기화
    // 단, 게임 시작(미리보기) 직후 10초 동안은 보호함
    const isProtected = Date.now() - gameStartTimeRef.current < 10000;

    if (flippedCount === TOTAL_CARDS && !isProtected) {
      resetCounterRef.current++;
      if (resetCounterRef.current >= RESET_PERSISTENCE_FRAMES) {
        setCards(prev => prev.map(c => ({ ...c, image: null, isFlipped: false, isCapturing: false, detectedAt: null })));
        addLog('모든 카드가 앞면인 상태가 유지되어 그리드를 초기화합니다. (게임 종료)');
        resetCounterRef.current = 0;
      }
    } else {
      resetCounterRef.current = 0;
      if (hasChanges) {
        setCards(nextCards);
      }
    }

    requestRef.current = requestAnimationFrame(processFrame);
  }, [isStreaming]);

  // --- Screen Capture ---
  const startCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "never", frameRate: 60 } as any,
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play();
          setIsStreaming(true);
          // 스트리밍 시작 시 기존 선택 영역이 있으면 사용, 없으면 기본 좌표로 그리드 자동 적용
          if (selection) {
            updateGridFromSelection(selection, manualRect.gapX, manualRect.gapY, manualRect.offsetX, manualRect.offsetY, manualRect.detectionSize);
            addLog('화면 공유 시작. 기존 좌표로 그리드를 설정했습니다.');
          } else {
            const defaultSel = {
              startX: DEFAULT_RECT.x,
              startY: DEFAULT_RECT.y,
              width: DEFAULT_RECT.w,
              height: DEFAULT_RECT.h
            };
            setSelection(defaultSel);
            updateGridFromSelection(defaultSel, manualRect.gapX, manualRect.gapY, manualRect.offsetX, manualRect.offsetY, manualRect.detectionSize);
            addLog('화면 공유 시작. 기본 좌표로 그리드를 자동 설정했습니다.');
          }
        };
      }
    } catch (err) {
      console.error('Capture Error:', err);
      addLog('화면 공유를 시작하지 못했습니다.');
    }
  };

  const stopCapture = () => {
    if (videoRef.current?.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsStreaming(false);
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    addLog('모니터링이 중단되었습니다.');
  };

  useEffect(() => {
    if (isStreaming) {
      requestRef.current = requestAnimationFrame(processFrame);
      fpsIntervalRef.current = setInterval(() => {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
      }, 1000);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
    };
  }, [isStreaming, processFrame]);

  const manualReset = () => {
    setCards(prev => prev.map(c => ({ ...c, image: null, isFlipped: false, isCapturing: false, detectedAt: null })));
    addLog('사용자 요청으로 그리드를 초기화했습니다.');
  };

  // --- UI ---
  const isRecording = cards.some(c => c.isCapturing);
  const avgBaseline = cards.length > 0
    ? Math.round(cards.reduce((acc, c) => acc + (c.baselineBrightness || REFERENCE_BACK_BRIGHTNESS), 0) / cards.length)
    : REFERENCE_BACK_BRIGHTNESS;

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-zinc-100 font-sans selection:bg-orange-500/30">
      <header className="border-b border-zinc-800/50 bg-zinc-900/30 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center shadow-lg shadow-orange-900/20">
              <Grid3X3 className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">세븐나이츠 리버스 메모리 게임 헬퍼</h1>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowUsage(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all border border-zinc-700"
            >
              <Monitor className="w-4 h-4" />
              사용법
            </button>
            <button
              onClick={manualReset}
              className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-orange-400 transition-colors"
              title="전체 초기화"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              <div className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-2 ${isStreaming ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-zinc-800 text-zinc-400'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-green-400 animate-pulse' : 'bg-zinc-500'}`} />
                {isStreaming ? '라이브' : '대기중'}
              </div>

              {isStreaming && (
                <>
                  {isRecording && (
                    <div className="px-3 py-1 rounded-full text-xs font-medium flex items-center gap-2 bg-orange-500/10 text-orange-400 border border-orange-500/20 animate-pulse">
                      <div className="w-1.5 h-1.5 rounded-full bg-orange-400" />
                      기록중
                    </div>
                  )}
                </>
              )}
            </div>

            <button
              onClick={isStreaming ? stopCapture : startCapture}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${isStreaming
                  ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                  : 'bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-900/20'
                }`}
            >
              {isStreaming ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              {isStreaming ? '중단' : '시작'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-6 space-y-6">
          {/* Active Configuration Summary */}
          <section className="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4 grid grid-cols-2 md:grid-cols-6 gap-4 shadow-inner">
            <div className="space-y-1 border-r border-zinc-800/50 pr-2">
              <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">영역 (X,Y,W,H)</p>
              <p className="text-xs font-mono text-orange-400">
                {manualRect.x},{manualRect.y} <span className="text-zinc-600 text-[9px]">({manualRect.w}x{manualRect.h})</span>
              </p>
            </div>
            <div className="space-y-1 border-r border-zinc-800/50 pr-2">
              <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">민감도</p>
              <p className="text-xs font-mono text-green-400">{sensitivity}%</p>
            </div>
            <div className="space-y-1 border-r border-zinc-800/50 pr-2">
              <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">기준 밝기</p>
              <p className="text-xs font-mono text-yellow-400">{avgBaseline}</p>
            </div>
            <div className="space-y-1 border-r border-zinc-800/50 pr-2">
              <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">시작 지연</p>
              <p className="text-xs font-mono text-blue-400">{pauseDuration}ms</p>
            </div>
            <div className="space-y-1 border-r border-zinc-800/50 pr-2">
              <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">오버레이</p>
              <p className="text-xs font-mono text-purple-400">{overlayThreshold}개</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">성능</p>
              <p className="text-xs font-mono text-zinc-300">{fps} <span className="text-[9px] text-zinc-600">FPS</span></p>
            </div>
          </section>

          <div className="flex items-center gap-2 text-zinc-400 mb-2">
            <Camera className="w-4 h-4" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">캡처 및 캘리브레이션</h2>
          </div>

          {/* Video Container with Drag Selection */}
          <section
            ref={containerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            className="bg-zinc-900/50 border border-zinc-800 rounded-2xl overflow-hidden relative aspect-video cursor-crosshair select-none"
          >
            <video ref={videoRef} className="w-full h-full object-cover pointer-events-none" muted playsInline />

            {/* Selection Overlay */}
            {isDragging && dragStart && currentDrag && (
              <div
                className="absolute border-2 border-orange-500 bg-orange-500/20 pointer-events-none"
                style={{
                  left: Math.min(dragStart.x, currentDrag.x),
                  top: Math.min(dragStart.y, currentDrag.y),
                  width: Math.abs(currentDrag.x - dragStart.x),
                  height: Math.abs(currentDrag.y - dragStart.y),
                }}
              />
            )}

            {!isStreaming && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-sm text-zinc-500">
                <Monitor className="w-12 h-12 mb-4 opacity-20" />
                <p className="text-sm">화면 공유를 시작하여 캘리브레이션을 진행하세요</p>
              </div>
            )}

            {selection && !isDragging && (
              <div
                className="absolute border-2 border-green-500/50 bg-green-500/5 pointer-events-none"
                style={{
                  left: selection.startX,
                  top: selection.startY,
                  width: selection.width,
                  height: selection.height,
                }}
              >
                {/* Visual Grid Guide */}
                <div
                  className="w-full h-full grid grid-cols-8 grid-rows-3"
                  style={{ gap: `${manualRect.gapY}px ${manualRect.gapX}px` }}
                >
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div key={i} className="border border-green-500/30 flex items-center justify-center relative">
                      {/* Detection Area Box (Visualizing the detection zone) */}
                      <div
                        className="absolute border border-green-400/60 rounded-[1px]"
                        style={{
                          width: `${manualRect.detectionSize}px`,
                          height: `${manualRect.detectionSize}px`,
                          transform: `translate(${manualRect.offsetX}px, ${manualRect.offsetY}px)`
                        }}
                      />
                      {/* Center Detection Point Marker */}
                      <div
                        className="w-1 h-1 bg-white rounded-full shadow-[0_0_4px_rgba(255,255,255,0.8)] opacity-60 z-10"
                        style={{ transform: `translate(${manualRect.offsetX}px, ${manualRect.offsetY}px)` }}
                      />
                      {/* Optional: Cell Index for debugging */}
                      <span className="absolute top-0.5 left-0.5 text-[8px] text-green-500/40 font-mono">{i + 1}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <canvas ref={canvasRef} className="hidden" />
            <canvas ref={pipCanvasRef} width={800} height={400} className="hidden" />
            <video ref={pipVideoRef} className="hidden" muted playsInline />
          </section>

          {/* Manual Calibration Panel */}
          <section className="bg-zinc-900/50 border border-zinc-800 rounded-2xl overflow-hidden">
            <button
              onClick={() => setIsSettingsCollapsed(!isSettingsCollapsed)}
              className="w-full p-4 flex items-center justify-between hover:bg-zinc-800/50 transition-colors group"
            >
              <h3 className="text-xs font-bold text-zinc-400 uppercase flex items-center gap-2 group-hover:text-zinc-200 transition-colors">
                <MousePointer2 className="w-3 h-3" />
                수동 좌표 정밀 캘리브레이션
              </h3>
              {isSettingsCollapsed ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronUp className="w-4 h-4 text-zinc-500" />}
            </button>

            <AnimatePresence initial={false}>
              {!isSettingsCollapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: 'easeInOut' }}
                >
                  <div className="p-4 pt-0 space-y-4 border-t border-zinc-800/50">
                    <div className="flex items-center justify-end gap-2 mb-2">
                      <button
                        onClick={recalibrateBaseline}
                        disabled={!isStreaming}
                        className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 text-[10px] font-bold rounded-md transition-all border border-zinc-700"
                      >
                        밝기 기준 재설정
                      </button>
                      <button
                        onClick={applyManualRect}
                        disabled={!isStreaming}
                        className="px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[10px] font-bold rounded-md transition-all"
                      >
                        좌표 적용
                      </button>
                    </div>

                    <div className="space-y-4">
                      {/* Group 1: Grid Layout */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                          <Grid3X3 className="w-3 h-3" />
                          그리드 레이아웃
                        </div>
                        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 p-3 bg-zinc-950/30 rounded-xl border border-zinc-800/50">
                          {[
                            { label: 'X (좌측)', key: 'x' },
                            { label: 'Y (상단)', key: 'y' },
                            { label: '너비 (W)', key: 'w' },
                            { label: '높이 (H)', key: 'h' },
                            { label: '가로 간격', key: 'gapX' },
                            { label: '세로 간격', key: 'gapY' },
                          ].map((field) => (
                            <div key={field.key} className="space-y-1.5">
                              <label className="text-[10px] text-zinc-500 font-medium">{field.label}</label>
                              <input
                                type="number"
                                value={manualRect[field.key as keyof typeof manualRect]}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 0;
                                  const next = { ...manualRect, [field.key]: val };
                                  setManualRect(next);
                                  const newSelection = { startX: next.x, startY: next.y, width: next.w, height: next.h };
                                  setSelection(newSelection);
                                  updateGridFromSelection(newSelection, next.gapX, next.gapY, next.offsetX, next.offsetY, next.detectionSize);
                                }}
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-orange-400 focus:outline-none focus:border-orange-500/50 transition-colors"
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Group 2: Detection Point & Area */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                          <MousePointer2 className="w-3 h-3" />
                          감지 포인트 및 영역
                        </div>
                        <div className="grid grid-cols-3 md:grid-cols-3 gap-3 p-3 bg-zinc-950/30 rounded-xl border border-zinc-800/50">
                          {[
                            { label: 'X 오프셋', key: 'offsetX' },
                            { label: 'Y 오프셋', key: 'offsetY' },
                            { label: '감지 크기', key: 'detectionSize' },
                          ].map((field) => (
                            <div key={field.key} className="space-y-1.5">
                              <label className="text-[10px] text-zinc-500 font-medium">{field.label}</label>
                              <input
                                type="number"
                                value={manualRect[field.key as keyof typeof manualRect]}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 0;
                                  const next = { ...manualRect, [field.key]: val };
                                  setManualRect(next);
                                  const newSelection = { startX: next.x, startY: next.y, width: next.w, height: next.h };
                                  setSelection(newSelection);
                                  updateGridFromSelection(newSelection, next.gapX, next.gapY, next.offsetX, next.offsetY, next.detectionSize);
                                }}
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-green-400 focus:outline-none focus:border-green-500/50 transition-colors"
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Group 3: Logic Settings */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                          <RefreshCw className="w-3 h-3" />
                          로직 설정
                        </div>
                        <div className="grid grid-cols-3 md:grid-cols-3 gap-3 p-3 bg-zinc-950/30 rounded-xl border border-zinc-800/50">
                          <div className="space-y-1.5">
                            <label className="text-[10px] text-blue-500 font-medium">시작 지연 (ms)</label>
                            <input
                              type="number"
                              step="100"
                              value={pauseDuration}
                              onChange={(e) => setPauseDuration(parseInt(e.target.value) || 0)}
                              className="w-full bg-zinc-950 border border-blue-900/30 rounded-lg px-2 py-1.5 text-xs text-blue-400 focus:outline-none focus:border-blue-500/50 transition-colors"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-[10px] text-purple-500 font-medium">오버레이 임계값</label>
                            <input
                              type="number"
                              value={overlayThreshold}
                              onChange={(e) => setOverlayThreshold(parseInt(e.target.value) || 1)}
                              className="w-full bg-zinc-950 border border-purple-900/30 rounded-lg px-2 py-1.5 text-xs text-purple-400 focus:outline-none focus:border-purple-500/50 transition-colors"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-[10px] text-green-500 font-medium">민감도 ({sensitivity}%)</label>
                            <input
                              type="range"
                              min="5"
                              max="40"
                              step="1"
                              value={sensitivity}
                              onChange={(e) => setSensitivity(parseInt(e.target.value))}
                              className="w-full h-8 accent-green-500 cursor-pointer"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>

        <div className="lg:col-span-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-5 h-5 text-orange-500" />
              <h2 className="text-xl font-bold tracking-tight">기록된 카드 (3x8)</h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={togglePip}
                className={`p-2 rounded-lg transition-all ${isPipActive
                    ? 'bg-orange-500 text-white shadow-[0_0_10px_rgba(249,115,22,0.4)]'
                    : 'hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100'
                  }`}
                title="PiP 모드 (게임 화면 위에 띄우기)"
              >
                <MonitorPlay className="w-5 h-5" />
              </button>
              <button
                onClick={() => {
                  setCards(prev => prev.map(c => ({ ...c, image: null })));
                  addLog('사용자에 의해 그리드가 초기화되었습니다.');
                }}
                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-zinc-100"
                title="이미지 초기화"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
              <button
                onClick={recalibrateBaseline}
                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-zinc-100"
                title="밝기 기준점 재설정 (Ready 문구 사라진 후 클릭)"
              >
                <Camera className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            <AnimatePresence mode="popLayout">
              {cards.map((card, idx) => (
                <motion.div
                  key={card.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={`aspect-[3/4] rounded-lg border flex flex-col items-center justify-center relative overflow-hidden transition-all duration-300 ${card.isCapturing
                      ? 'bg-orange-500/10 border-orange-500/30'
                      : card.image
                        ? 'bg-zinc-800/80 border-zinc-700 shadow-lg'
                        : 'bg-zinc-900/20 border-zinc-800/50'
                    }`}
                >
                  <span className="absolute top-0.5 left-1 text-[8px] font-bold text-zinc-600 z-10">
                    {idx + 1}
                  </span>

                  {card.isCapturing && !card.image && (
                    <div className="w-2 h-2 border border-orange-400 border-t-transparent rounded-full animate-spin" />
                  )}

                  {card.image && (
                    <motion.img
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      src={card.image}
                      alt={`Card ${idx + 1}`}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  )}

                  {card.isFlipped && (
                    <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-[#0a0a0c] z-20" />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <section className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4 font-mono text-[11px] h-48 overflow-y-auto space-y-1 scrollbar-hide">
            <div className="text-zinc-500 flex items-center gap-2 mb-2 sticky top-0 bg-zinc-950 pb-2">
              <div className="w-1 h-1 bg-zinc-500 rounded-full" />
              실시간 시스템 로그
            </div>
            <div className="flex flex-col gap-1">
              {logs.map((log, i) => (
                <div key={i} className={`${i === 0 ? 'text-orange-400' : 'text-zinc-500'} border-l border-zinc-800 pl-2`}>
                  <span className="opacity-30 mr-2">[{new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                  {`> ${log}`}
                </div>
              ))}
            </div>
            {!selection && isStreaming && (
              <div className="text-blue-400 animate-pulse mt-2">{`> 알림: 화면 위에서 3x8 카드 영역을 드래그하여 지정해주세요.`}</div>
            )}
          </section>
        </div>
      </main>

      <UsageModal />
    </div>
  );
}
