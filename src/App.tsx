import { useState, useRef, useCallback, useEffect } from 'react'
import type { Results, Detection } from '@mediapipe/face_detection'
import './App.css'

// Loaded via CDN <script> in index.html
type Detector = {
  setOptions(opts: { model?: string; minDetectionConfidence?: number }): void
  onResults(cb: (results: Results) => void): void
  initialize(): Promise<void>
  send(inputs: { image: HTMLCanvasElement | HTMLImageElement }): Promise<void>
}

declare const FaceDetection: new (config: { locateFile: (file: string) => string }) => Detector

const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1646425229/`
const CONFIDENCE = 0.25
const MOSAIC_CELLS = 5

type ItemStatus = 'pending' | 'processing' | 'done' | 'error'

interface ImageItem {
  id: string
  file: File
  originalUrl: string
  processedUrl: string | null
  status: ItemStatus
  faceCount: number
}

function applyMosaicToCanvas(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement | HTMLImageElement,
  x: number, y: number, w: number, h: number,
) {
  if (w < 2 || h < 2) return
  const tiny = document.createElement('canvas')
  tiny.width = MOSAIC_CELLS
  tiny.height = MOSAIC_CELLS
  tiny.getContext('2d')!.drawImage(source, x, y, w, h, 0, 0, MOSAIC_CELLS, MOSAIC_CELLS)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tiny, 0, 0, MOSAIC_CELLS, MOSAIC_CELLS, x, y, w, h)
  ctx.imageSmoothingEnabled = true
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function basename(file: File) {
  const dot = file.name.lastIndexOf('.')
  return dot > 0 ? file.name.slice(0, dot) : file.name
}

async function saveImage(dataUrl: string, fileName: string) {
  if (typeof navigator.canShare === 'function') {
    try {
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      const file = new File([blob], fileName, { type: 'image/png' })
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName })
        return
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
    }
  }
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = fileName
  a.click()
}

// ── 수동 편집 모달 ──────────────────────────────────────────

interface EditModalProps {
  item: ImageItem
  onSave: (newUrl: string) => void
  onClose: () => void
}

function EditModal({ item, onSave, onClose }: EditModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)  // 편집 중인 현재 상태
  const originalRef = useRef<HTMLCanvasElement | null>(null)   // 원본 이미지 (복구용)
  const isDrawing = useRef(false)
  const startPos = useRef({ x: 0, y: 0 })
  const historyRef = useRef<ImageData[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [mode, setMode] = useState<'mosaic' | 'restore'>('mosaic')

  useEffect(() => {
    const canvas = canvasRef.current!
    const offscreen = document.createElement('canvas')
    const original = document.createElement('canvas')
    offscreenRef.current = offscreen
    originalRef.current = original

    // 처리된 이미지 로드
    const processed = new Image()
    processed.src = item.processedUrl ?? item.originalUrl
    processed.onload = () => {
      canvas.width = processed.naturalWidth
      canvas.height = processed.naturalHeight
      offscreen.width = processed.naturalWidth
      offscreen.height = processed.naturalHeight
      offscreen.getContext('2d')!.drawImage(processed, 0, 0)
      canvas.getContext('2d')!.drawImage(processed, 0, 0)
    }

    // 원본 이미지 별도 로드 (복구용)
    const orig = new Image()
    orig.src = item.originalUrl
    orig.onload = () => {
      original.width = orig.naturalWidth
      original.height = orig.naturalHeight
      original.getContext('2d')!.drawImage(orig, 0, 0)
    }
  }, [item])

  const redraw = (sel?: { x: number; y: number; w: number; h: number }, selMode?: 'mosaic' | 'restore') => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(offscreenRef.current!, 0, 0)
    if (sel && sel.w > 0 && sel.h > 0) {
      const isMosaic = (selMode ?? mode) === 'mosaic'
      ctx.save()
      ctx.strokeStyle = isMosaic ? '#ef4444' : '#10b981'
      ctx.lineWidth = Math.max(2, canvas.width * 0.003)
      ctx.setLineDash([10, 5])
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h)
      ctx.fillStyle = isMosaic ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'
      ctx.fillRect(sel.x, sel.y, sel.w, sel.h)
      ctx.restore()
    }
  }

  const toCanvasXY = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  const onStart = (clientX: number, clientY: number) => {
    startPos.current = toCanvasXY(clientX, clientY)
    isDrawing.current = true
  }

  const onMove = (clientX: number, clientY: number) => {
    if (!isDrawing.current) return
    const pos = toCanvasXY(clientX, clientY)
    redraw({
      x: Math.min(startPos.current.x, pos.x),
      y: Math.min(startPos.current.y, pos.y),
      w: Math.abs(pos.x - startPos.current.x),
      h: Math.abs(pos.y - startPos.current.y),
    })
  }

  const onEnd = (clientX: number, clientY: number) => {
    if (!isDrawing.current) return
    isDrawing.current = false
    const pos = toCanvasXY(clientX, clientY)
    const x = Math.min(startPos.current.x, pos.x)
    const y = Math.min(startPos.current.y, pos.y)
    const w = Math.abs(pos.x - startPos.current.x)
    const h = Math.abs(pos.y - startPos.current.y)

    if (w >= 2 && h >= 2) {
      const offscreen = offscreenRef.current!
      const ctx = offscreen.getContext('2d')!
      historyRef.current.push(ctx.getImageData(0, 0, offscreen.width, offscreen.height))
      setCanUndo(true)

      if (mode === 'mosaic') {
        applyMosaicToCanvas(ctx, offscreen, x, y, w, h)
      } else {
        // 원본 픽셀로 복구
        ctx.drawImage(originalRef.current!, x, y, w, h, x, y, w, h)
      }
    }
    redraw()
  }

  const handleUndo = () => {
    if (!historyRef.current.length) return
    const offscreen = offscreenRef.current!
    offscreen.getContext('2d')!.putImageData(historyRef.current.pop()!, 0, 0)
    setCanUndo(historyRef.current.length > 0)
    redraw()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-top">
            <span className="modal-title">드래그로 영역 선택</span>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
          <div className="mode-toggle">
            <button
              className={`mode-btn${mode === 'mosaic' ? ' active' : ''}`}
              onClick={() => setMode('mosaic')}>
              ✦ 모자이크
            </button>
            <button
              className={`mode-btn${mode === 'restore' ? ' active restore' : ''}`}
              onClick={() => setMode('restore')}>
              ↩ 원본 복구
            </button>
          </div>
        </div>

        <div className="modal-body">
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            onMouseDown={e => onStart(e.clientX, e.clientY)}
            onMouseMove={e => onMove(e.clientX, e.clientY)}
            onMouseUp={e => onEnd(e.clientX, e.clientY)}
            onMouseLeave={e => { if (isDrawing.current) onEnd(e.clientX, e.clientY) }}
            onTouchStart={e => { e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY) }}
            onTouchMove={e => { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY) }}
            onTouchEnd={e => { e.preventDefault(); onEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY) }}
          />
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={handleUndo} disabled={!canUndo}>
            ↩ 되돌리기
          </button>
          <button className="btn btn-primary" onClick={() => onSave(canvasRef.current!.toDataURL('image/png'))}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 메인 앱 ─────────────────────────────────────────────────

export default function App() {
  const [items, setItems] = useState<ImageItem[]>([])
  const [isLoadingModel, setIsLoadingModel] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [editItem, setEditItem] = useState<ImageItem | null>(null)

  const detectorRef = useRef<Detector | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const addMoreRef = useRef<HTMLInputElement>(null)

  const addFiles = (files: FileList | File[]) => {
    const next: ImageItem[] = Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .map(file => ({
        id: makeId(),
        file,
        originalUrl: URL.createObjectURL(file),
        processedUrl: null,
        status: 'pending' as const,
        faceCount: 0,
      }))
    setItems(prev => [...prev, ...next])
  }

  const getDetector = useCallback(async () => {
    if (detectorRef.current) return detectorRef.current
    setIsLoadingModel(true)
    const det = new FaceDetection({ locateFile: f => CDN + f })
    det.setOptions({ model: 'short', minDetectionConfidence: 0.5 })
    await det.initialize()
    detectorRef.current = det
    setIsLoadingModel(false)
    return det
  }, [])

  const processOne = async (item: ImageItem): Promise<{ processedUrl: string; faceCount: number }> => {
    const det = detectorRef.current!
    det.setOptions({ model: 'short', minDetectionConfidence: CONFIDENCE })

    const img = new Image()
    img.src = item.originalUrl
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej })

    const canvas = canvasRef.current!
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)

    let detections: Detection[] = []
    det.onResults((r: Results) => { detections = r.detections ?? [] })
    await det.send({ image: canvas })

    for (const d of detections) {
      const { xCenter: cx, yCenter: cy, width: nw, height: nh } = d.boundingBox
      const bw = nw * canvas.width
      const bh = nh * canvas.height
      const pad = 0.2
      const x = Math.max(0, cx * canvas.width - bw / 2 - bw * pad)
      const y = Math.max(0, cy * canvas.height - bh / 2 - bh * pad)
      const x2 = Math.min(canvas.width, cx * canvas.width + bw / 2 + bw * pad)
      const y2 = Math.min(canvas.height, cy * canvas.height + bh / 2 + bh * pad)
      applyMosaicToCanvas(ctx, img, x, y, x2 - x, y2 - y)
    }

    return { processedUrl: canvas.toDataURL('image/png'), faceCount: detections.length }
  }

  const handleProcessAll = async () => {
    const queue = items.filter(i => i.status === 'pending' || i.status === 'error')
    if (!queue.length) return
    setIsProcessing(true)
    await getDetector()
    for (const item of queue) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'processing' } : i))
      try {
        const result = await processOne(item)
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'done', ...result } : i))
      } catch (err) {
        console.error(err)
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error' } : i))
      }
    }
    setIsProcessing(false)
  }

  const handleSave = (item: ImageItem) => {
    if (!item.processedUrl) return
    saveImage(item.processedUrl, `${basename(item.file)}_blurred.png`)
  }

  const handleSaveAll = async () => {
    const done = items.filter(i => i.processedUrl)
    if (!done.length) return
    if (typeof navigator.canShare === 'function') {
      try {
        const files = await Promise.all(
          done.map(async item => {
            const res = await fetch(item.processedUrl!)
            const blob = await res.blob()
            return new File([blob], `${basename(item.file)}_blurred.png`, { type: 'image/png' })
          })
        )
        if (navigator.canShare({ files })) {
          await navigator.share({ files, title: '모자이크 처리된 이미지' })
          return
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
      }
    }
    for (const item of done) {
      const a = document.createElement('a')
      a.href = item.processedUrl!
      a.download = `${basename(item.file)}_blurred.png`
      a.click()
      await new Promise(r => setTimeout(r, 300))
    }
  }

  const handleEditSave = (id: string, newUrl: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, processedUrl: newUrl } : i))
    setEditItem(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const isBusy = isLoadingModel || isProcessing
  const doneCount = items.filter(i => i.status === 'done').length
  const pendingCount = items.filter(i => i.status === 'pending' || i.status === 'error').length
  const processingItem = items.findIndex(i => i.status === 'processing')

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">🫥 Face Blur</h1>
        <p className="tagline">얼굴 자동 감지 & 모자이크 — 브라우저 내 100% 처리</p>
      </header>

      <main className="main">
        {items.length === 0 ? (
          <div
            className={`dropzone${isDragging ? ' dragging' : ''}`}
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="dropzone-icon">📂</div>
            <p className="dropzone-title">이미지를 드래그하거나 클릭하여 업로드</p>
            <p className="dropzone-hint">여러 장 동시 선택 가능 · JPG · PNG · WEBP</p>
            <input ref={fileInputRef} type="file" accept="image/*" multiple
              onChange={e => e.target.files && addFiles(e.target.files)} hidden />
          </div>
        ) : (
          <div className="workspace">
            <div className="toolbar">
              <span className="count-text">
                {items.length}장
                {doneCount > 0 && <> · <span className="count-done">완료 {doneCount}장</span></>}
              </span>
              <div className="toolbar-actions">
                <button className="btn btn-ghost btn-sm"
                  onClick={() => addMoreRef.current?.click()} disabled={isBusy}>+ 추가</button>
                <button className="btn btn-ghost btn-sm"
                  onClick={() => setItems([])} disabled={isBusy}>전체 삭제</button>
                <button className="btn btn-primary"
                  onClick={handleProcessAll} disabled={isBusy || pendingCount === 0}>
                  {isLoadingModel ? '모델 로딩 중...'
                    : isProcessing ? `처리 중 ${processingItem + 1}/${items.length}`
                    : pendingCount > 0 ? `감지 & 모자이크 처리 (${pendingCount}장)`
                    : '모두 처리됨'}
                </button>
                {doneCount > 0 && (
                  <button className="btn btn-download" onClick={handleSaveAll} disabled={isBusy}>
                    ⬇ 일괄 저장 ({doneCount}장)
                  </button>
                )}
              </div>
              <input ref={addMoreRef} type="file" accept="image/*" multiple
                onChange={e => e.target.files && addFiles(e.target.files)} hidden />
            </div>

            {(isLoadingModel || isProcessing) && (
              <div className="status-bar">
                <span className="spinner" />
                {isLoadingModel ? 'AI 모델 로딩 중 (최초 1회)...' : '얼굴 감지 중...'}
              </div>
            )}

            <div className="grid">
              {items.map(item => (
                <div key={item.id} className={`card card-${item.status}`}>
                  <div className="card-thumb">
                    <img src={item.processedUrl ?? item.originalUrl}
                      alt={item.file.name} className="card-img" />
                    {item.status === 'processing' && (
                      <div className="card-overlay"><span className="spinner spinner-lg" /></div>
                    )}
                    <button className="card-remove"
                      onClick={() => setItems(prev => prev.filter(i => i.id !== item.id))}
                      disabled={item.status === 'processing'}
                      aria-label="삭제">×</button>
                  </div>

                  <div className="card-footer">
                    <span className="card-name" title={item.file.name}>{item.file.name}</span>
                    <div className="card-row">
                      <span className={`card-status card-status-${item.status}`}>
                        {item.status === 'pending' && '대기'}
                        {item.status === 'processing' && '처리 중'}
                        {item.status === 'done' && (item.faceCount > 0 ? `✓ ${item.faceCount}명` : '✓ 미감지')}
                        {item.status === 'error' && '⚠ 오류'}
                      </span>
                      {item.status === 'done' && (
                        <div className="card-actions">
                          <button className="btn-edit" onClick={() => setEditItem(item)}
                            title="직접 편집">✏️</button>
                          <button className="btn-save" onClick={() => handleSave(item)}>
                            저장하기
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="footer">
        <p>모든 처리는 브라우저 내 클라이언트 사이드 — 서버 전송 없음</p>
      </footer>

      <canvas ref={canvasRef} hidden />

      {editItem && (
        <EditModal
          item={editItem}
          onSave={url => handleEditSave(editItem.id, url)}
          onClose={() => setEditItem(null)}
        />
      )}
    </div>
  )
}
