import { useState, useRef } from 'react'
import type { VimMode } from '../types/textInputTypes.js'

export interface EditorState {
  // v-for-editor render progress. Inline in the footer — notifications
  // render inside PromptInput which isn't mounted in transcript.
  editorStatus: string
  setEditorStatus: React.Dispatch<React.SetStateAction<string>>
  // Incremented on transcript exit. Async v-render captures this at start;
  // each status write no-ops if stale (user left transcript mid-render —
  // the stable setState would otherwise stamp a ghost toast into the next
  // session). Also clears any pending 4s auto-clear.
  editorGenRef: React.MutableRefObject<number>
  editorTimerRef: React.MutableRefObject<
    ReturnType<typeof setTimeout> | undefined
  >
  editorRenderingRef: React.MutableRefObject<boolean>
  vimMode: VimMode
  setVimMode: React.Dispatch<React.SetStateAction<VimMode>>
  showBashesDialog: string | boolean
  setShowBashesDialog: React.Dispatch<React.SetStateAction<string | boolean>>
  isSearchingHistory: boolean
  setIsSearchingHistory: React.Dispatch<React.SetStateAction<boolean>>
  isHelpOpen: boolean
  setIsHelpOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export function useEditorState(): EditorState {
  const [editorStatus, setEditorStatus] = useState('')
  const editorGenRef = useRef(0)
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const editorRenderingRef = useRef(false)
  const [vimMode, setVimMode] = useState<VimMode>('INSERT')
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(
    false,
  )
  const [isSearchingHistory, setIsSearchingHistory] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)

  return {
    editorStatus,
    setEditorStatus,
    editorGenRef,
    editorTimerRef,
    editorRenderingRef,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    isSearchingHistory,
    setIsSearchingHistory,
    isHelpOpen,
    setIsHelpOpen,
  }
}
