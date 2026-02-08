import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"

// ================================
// Types for Summary Storage
// ================================

interface SummarySection {
  title: string // Max 157 chars per diagram spec
  content: string // Max 785 chars per diagram spec
  keywords: string[]
  timestamp: number
}

interface SummaryDocument {
  originalText: string
  summaryTitle: string
  sections: SummarySection[]
  totalCharacters: number
  createdAt: number
  lastModified: number
}

/**
 * SummaryStorage - Simple storage for non-agentic summary flow
 *
 * According to architecture diagram, this handles the simple summarization flow:
 * SummaryASRController → SummaryStorage → SummaryBridge → AISummarizer → SummaryComponent
 *
 * This is NOT part of the agentic tool system - it's a simple summarization service
 * that formats lecture content into readable cards for the summary UI component.
 */
@component
export class SummaryStorage extends BaseScriptComponent {
  // ================================
  // Inspector Configuration
  // ================================

  @input
  @hint("Enable automatic summary storage")
  public enableStorage: boolean = true

  @input
  @hint("Persist summary/transcript to Lens Studio Persistent Storage (disable for vectorDB-only demos)")
  public enablePersistentStorage: boolean = true

  @input
  @hint("Export transcript/summary text files into Persistent Storage panel (disable for vectorDB-only demos)")
  public enableStorageExports: boolean = true

  @input
  @hint("Enable debug logging for storage operations")
  public enableDebugLogging: boolean = false

  @input
  @hint("Maximum number of summaries to store")
  @widget(new SliderWidget(1, 20, 1))
  public maxStoredSummaries: number = 5

  @input
  @hint("Current summary title")
  public currentSummaryTitle: string = "Lecture Summary"

  // ================================
  // State Management
  // ================================

  private isInitialized: boolean = false
  private currentOriginalText: string = ""
  private currentSummaryDocument: SummaryDocument | null = null
  private storedSummaries: Map<string, SummaryDocument> = new Map()
  private storageKey: string = "agentic_summary_storage"
  private hasActiveSession: boolean = false // Track if we have an active accumulation session

  // ================================
  // Events
  // ================================

  public onTextStored: Event<string> = new Event<string>()
  public onSummaryGenerated: Event<SummaryDocument> = new Event<SummaryDocument>()
  public onSummaryUpdated: Event<SummaryDocument> = new Event<SummaryDocument>()
  public onStorageError: Event<string> = new Event<string>()

  // ================================
  // Lifecycle Methods
  // ================================

  onAwake() {
    print(`SummaryStorage: 🌅 onAwake called - currentOriginalText length: ${this.currentOriginalText.length}`)
    this.initialize()
    print(`SummaryStorage: 🌅 After initialize - currentOriginalText length: ${this.currentOriginalText.length}`)
  }

  // ================================
  // Public Interface - Text Collection
  // ================================

  /**
   * Store incoming text from SummaryASRController
   * This accumulates the raw transcript before summarization
   */
  public storeText(text: string): void {
    if (!text || text.trim().length === 0) {
      if (this.enableDebugLogging) {
        print("SummaryStorage: Empty text provided, ignoring")
      }
      return
    }

    print(
      `SummaryStorage: 📝 storeText called with ${text.length} chars. Current total before: ${this.currentOriginalText.length}`
    )

    // Append to current original text
    if (this.currentOriginalText.length > 0) {
      this.currentOriginalText += " " + text.trim()
    } else {
      this.currentOriginalText = text.trim()
    }

    this.onTextStored.invoke(this.currentOriginalText)

    if (this.enableDebugLogging) {
      print(`SummaryStorage: 📝 Text stored, total length: ${this.currentOriginalText.length} characters`)
    }

    this.saveToStorage()
    
    // Export transcription to file for demo verification (REAL DATA)
    if (this.enablePersistentStorage && this.enableStorageExports && this.currentOriginalText.length > 50) {
      this.exportTranscriptionToFile()
    }
  }

  /**
   * Export current transcription to file for demo/debugging
   * Saves REAL captured audio data to persistent storage
   */
  private exportTranscriptionToFile(): void {
    if (!this.enablePersistentStorage || !this.enableStorageExports) {
      return
    }
    if (!this.currentOriginalText || this.currentOriginalText.length === 0) {
      return
    }

    const timestamp = Date.now()
    const filename = `transcript_${timestamp}.txt`
    
    try {
      const content = `=== LECTURE TRANSCRIPTION (REAL DATA) ===
Captured: ${new Date().toLocaleString()}
Length: ${this.currentOriginalText.length} characters
Words: ~${Math.floor(this.currentOriginalText.length / 5)}

---

${this.currentOriginalText}
`
      
      // Use global persistent storage (same as saveToStorage method)
      if (global.persistentStorageSystem) {
        const store = global.persistentStorageSystem.store
        store.putString(filename, content)
        
        print(`SummaryStorage: ✅ Transcription exported to ${filename}`)
        print(`SummaryStorage: 📁 View in: Lens Studio > Persistent Storage panel`)
      } else {
        print(`SummaryStorage: ⚠️ PersistentStorage not available`)
      }
    } catch (error) {
      print(`SummaryStorage: ⚠️ Export failed: ${error}`)
    }
  }

  /**
   * Get the accumulated original text for summarization
   */
  public getCurrentText(): string {
    if (this.enableDebugLogging) {
      print(`SummaryStorage: 📖 getCurrentText called - returning ${this.currentOriginalText.length} chars`)
      print(
        `SummaryStorage: DEBUG - currentOriginalText first 100 chars: "${this.currentOriginalText.substring(0, 100)}..."`
      )
      print(`SummaryStorage: 🔍 DEBUG - isInitialized: ${this.isInitialized}, enableStorage: ${this.enableStorage}`)
    }
    return this.currentOriginalText
  }

  /**
   * Clear the current text accumulation
   */
  public clearCurrentText(): void {
    this.currentOriginalText = ""
    this.currentSummaryDocument = null

    if (this.enableDebugLogging) {
      print("SummaryStorage: Current text cleared")
    }

    this.saveToStorage()
  }

  // ================================
  // Public Interface - Summary Management
  // ================================

  /**
   * Store generated summary sections from AISummarizer
   */
  public storeSummary(sections: SummarySection[], title?: string): void {
    if (!sections || sections.length === 0) {
      print("SummaryStorage: ⚠️ storeSummary() called with NO sections!")
      return
    }

    const summaryTitle = title || this.currentSummaryTitle
    const timestamp = Date.now()

    print(`SummaryStorage: 📝 storeSummary() called with ${sections.length} sections`)
    print(`SummaryStorage: 📝 Summary title: "${summaryTitle}"`)
    print(`SummaryStorage: 📝 Original text length: ${this.currentOriginalText.length}`)

    this.currentSummaryDocument = {
      originalText: this.currentOriginalText,
      summaryTitle: summaryTitle,
      sections: sections,
      totalCharacters: this.currentOriginalText.length,
      createdAt: timestamp,
      lastModified: timestamp
    }

    // Store in collection
    const summaryId = `summary_${timestamp}`
    this.storedSummaries.set(summaryId, this.currentSummaryDocument)

    print(`SummaryStorage: ✅ Summary stored in memory with ID: ${summaryId}`)
    print(`SummaryStorage: ✅ Total summaries in map: ${this.storedSummaries.size}`)

    // Maintain storage limit
    this.cleanupOldSummaries()

    this.onSummaryGenerated.invoke(this.currentSummaryDocument)

    print(`SummaryStorage: 💾 Now calling saveToStorage() to persist...`)
    this.saveToStorage()
    
    // Export summary to file for demo verification (REAL DATA)
    if (this.enablePersistentStorage && this.enableStorageExports) {
      this.exportSummaryToFile()
    }
    
    print(`SummaryStorage: ✅ storeSummary() completed successfully`)
  }

  /**
   * Export generated summary to file for demo/debugging
   * Saves REAL AI-generated summary to persistent storage
   */
  private exportSummaryToFile(): void {
    if (!this.enablePersistentStorage || !this.enableStorageExports) {
      return
    }
    if (!this.currentSummaryDocument) {
      return
    }

    const timestamp = Date.now()
    const filename = `summary_${timestamp}.txt`
    
    try {
      let content = `=== LECTURE SUMMARY (REAL AI-GENERATED) ===
Generated: ${new Date().toLocaleString()}
Title: ${this.currentSummaryDocument.summaryTitle}
Original Length: ${this.currentSummaryDocument.totalCharacters} characters
Summary Sections: ${this.currentSummaryDocument.sections.length}

---

`
      
      this.currentSummaryDocument.sections.forEach((section, index) => {
        content += `\n[SECTION ${index + 1}] ${section.title}\n`
        content += `${section.content}\n`
        if (section.keywords && section.keywords.length > 0) {
          content += `Keywords: ${section.keywords.join(', ')}\n`
        }
        content += `\n---\n`
      })
      
      content += `\n\nORIGINAL TRANSCRIPTION:\n${this.currentSummaryDocument.originalText}`
      
      // Use global persistent storage (same as saveToStorage method)
      if (global.persistentStorageSystem) {
        const store = global.persistentStorageSystem.store
        store.putString(filename, content)
        
        print(`SummaryStorage: ✅ Summary exported to ${filename}`)
        print(`SummaryStorage: 📁 ${this.currentSummaryDocument.sections.length} sections available for Gemini`)
        print(`SummaryStorage: 📁 View in: Lens Studio > Persistent Storage panel`)
      } else {
        print(`SummaryStorage: ⚠️ PersistentStorage not available`)
      }
    } catch (error) {
      print(`SummaryStorage: ⚠️ Export failed: ${error}`)
    }
  }

  /**
   * Get the current summary document
   */
  public getCurrentSummary(): SummaryDocument | null {
    // Always log what we're returning for debugging
    if (this.enableDebugLogging) {
      if (this.currentSummaryDocument) {
        print(`SummaryStorage: getCurrentSummary() - returning document with ${this.currentSummaryDocument.sections.length} sections`)
      } else {
        print(`SummaryStorage: getCurrentSummary() - returning NULL (no summary available)`)
      }
    }
    
    // If no current summary in memory, try to get the most recent one from stored summaries
    if (!this.currentSummaryDocument && this.storedSummaries.size > 0) {
      print(`SummaryStorage: No current summary, trying to get most recent from storage (${this.storedSummaries.size} summaries)`)
      const summariesArray = Array.from(this.storedSummaries.values()).sort((a, b) => b.createdAt - a.createdAt)
      if (summariesArray.length > 0) {
        this.currentSummaryDocument = summariesArray[0]
        print(`SummaryStorage: ✅ Retrieved most recent summary: "${this.currentSummaryDocument.summaryTitle}"`)
      }
    }
    
    return this.currentSummaryDocument
  }

  /**
   * Get all stored summaries
   */
  public getAllSummaries(): SummaryDocument[] {
    return Array.from(this.storedSummaries.values())
  }

  /**
   * Get summary by ID
   */
  public getSummaryById(summaryId: string): SummaryDocument | null {
    return this.storedSummaries.get(summaryId) || null
  }

  // ================================
  // Storage Management
  // ================================

  private initialize(): void {
    print(`SummaryStorage: Initialize called - enableStorage: ${this.enableStorage}`)
    
    // Check device environment
    this.checkDeviceEnvironment()
    
    try {
      if (!this.enablePersistentStorage) {
        print("SummaryStorage: 🧠 VectorDB-only mode: persistent storage disabled (in-memory only)")
      }

      // Only load from storage if we don't have active text
      if (this.enablePersistentStorage && this.currentOriginalText.length === 0) {
        this.loadFromStorage()
      } else {
        print(
          `SummaryStorage: Skipping loadFromStorage - preserving active text (${this.currentOriginalText.length} chars)`
        )
      }

      this.isInitialized = true

      if (this.enableDebugLogging) {
        print(`SummaryStorage: Initialized with ${this.storedSummaries.size} stored summaries`)
      }
    } catch (error) {
      if (this.enableDebugLogging) {
        print(`SummaryStorage: Initialization error: ${error}`)
      }
      this.onStorageError.invoke(`Initialization failed: ${error}`)
    }
  }
  
  /**
   * Check device environment and storage availability
   */
  private checkDeviceEnvironment(): void {
    print("SummaryStorage: 🔍 Checking device environment...")
    
    // Check persistent storage
    if (global.persistentStorageSystem) {
      print("SummaryStorage: ✅ Persistent storage system available")
      const store = global.persistentStorageSystem.store
      if (store) {
        print("SummaryStorage: ✅ Storage store accessible")
      } else {
        print("SummaryStorage: ❌ WARNING: Storage store is NULL!")
      }
    } else {
      print("SummaryStorage: ❌ CRITICAL: global.persistentStorageSystem NOT AVAILABLE!")
      print("SummaryStorage: ⚠️ All storage operations will FAIL on this device")
    }
  }

  private saveToStorage(): void {
    if (!this.enableStorage) {
      print(`SummaryStorage: 🚫 saveToStorage skipped - enableStorage is false`)
      return
    }
    if (!this.enablePersistentStorage) {
      if (this.enableDebugLogging) {
        print(`SummaryStorage: 🚫 saveToStorage skipped - enablePersistentStorage is false`)
      }
      return
    }

    print(`SummaryStorage: 💾 saveToStorage() called`)
    print(`SummaryStorage: 💾 Current summary document: ${this.currentSummaryDocument ? 'EXISTS' : 'NULL'}`)
    print(`SummaryStorage: 💾 Stored summaries count: ${this.storedSummaries.size}`)

    try {
      const storageData = {
        currentText: this.currentOriginalText,
        currentSummary: this.currentSummaryDocument,
        summaries: Array.from(this.storedSummaries.entries()),
        lastSaved: Date.now()
      }

      print(`SummaryStorage: 💾 Prepared data: text=${this.currentOriginalText.length}chars, summary=${storageData.currentSummary ? 'YES' : 'NO'}, summaries=${storageData.summaries.length}`)

      // Use Snap's persistent storage
      if (global.persistentStorageSystem) {
        const store = global.persistentStorageSystem.store
        const jsonString = JSON.stringify(storageData)
        print(`SummaryStorage: 💾 JSON string length: ${jsonString.length} bytes`)
        
        store.putString(this.storageKey, jsonString)

        print(`SummaryStorage: ✅ Data saved to persistent storage with key: "${this.storageKey}"`)
        print(`SummaryStorage: ✅ Summary will be available for Gemini on next query`)
      } else {
        print(`SummaryStorage: ❌ global.persistentStorageSystem is NOT available!`)
      }
    } catch (error) {
      print(`SummaryStorage: ❌ Save error: ${error}`)
      this.onStorageError.invoke(`Save failed: ${error}`)
    }
  }

  private loadFromStorage(): void {
    if (!this.enableStorage) {
      print(`SummaryStorage: 🚫 loadFromStorage skipped - enableStorage is false`)
      return
    }
    if (!this.enablePersistentStorage) {
      if (this.enableDebugLogging) {
        print(`SummaryStorage: 🚫 loadFromStorage skipped - enablePersistentStorage is false`)
      }
      return
    }

    try {
      if (global.persistentStorageSystem) {
        const store = global.persistentStorageSystem.store
        const storedDataString = store.getString(this.storageKey)

        print(`SummaryStorage: 🔍 loadFromStorage - current in-memory text length: ${this.currentOriginalText.length}`)
        print(
          `SummaryStorage: 💾 loadFromStorage - stored data exists: ${!!storedDataString}, length: ${storedDataString ? storedDataString.length : 0}`
        )

        if (storedDataString && storedDataString.length > 0) {
          const storageData = JSON.parse(storedDataString)

          // Load text from storage
          const storedTextLength = storageData.currentText ? storageData.currentText.length : 0
          print(`SummaryStorage: 📥 Loading stored text (${storedTextLength} chars)`)
          this.currentOriginalText = storageData.currentText || ""
          this.currentSummaryDocument = storageData.currentSummary || null

          // Restore summaries map
          this.storedSummaries.clear()
          if (storageData.summaries) {
            storageData.summaries.forEach(([key, value]) => {
              this.storedSummaries.set(key, value)
            })
          }

          if (this.enableDebugLogging) {
            print(`SummaryStorage: 📖 Loaded ${this.storedSummaries.size} summaries from storage`)
            print(`SummaryStorage: 📖 Loaded text length: ${this.currentOriginalText.length}`)
          }
        } else {
          print(`SummaryStorage: 📭 No stored data found - keeping current in-memory text`)
        }
      }
    } catch (error) {
      if (this.enableDebugLogging) {
        print(`SummaryStorage: Load error: ${error}`)
      }
      this.onStorageError.invoke(`Load failed: ${error}`)
    }
  }

  private cleanupOldSummaries(): void {
    if (this.storedSummaries.size <= this.maxStoredSummaries) {
      return
    }

    // Remove oldest summaries
    const summariesArray = Array.from(this.storedSummaries.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt)

    const toRemove = summariesArray.slice(0, summariesArray.length - this.maxStoredSummaries)

    toRemove.forEach(([key, _]) => {
      this.storedSummaries.delete(key)
    })

    if (this.enableDebugLogging && toRemove.length > 0) {
      print(`SummaryStorage: Cleaned up ${toRemove.length} old summaries`)
    }
  }

  // ================================
  // Utility Methods
  // ================================

  public clearAllSummaries(): void {
    this.storedSummaries.clear()
    this.currentSummaryDocument = null
    this.currentOriginalText = ""

    this.saveToStorage()

    if (this.enableDebugLogging) {
      print("SummaryStorage: All summaries cleared")
    }
  }

  public getStorageStats(): {totalSummaries: number; currentTextLength: number; hasCurrentSummary: boolean} {
    return {
      totalSummaries: this.storedSummaries.size,
      currentTextLength: this.currentOriginalText.length,
      hasCurrentSummary: this.currentSummaryDocument !== null
    }
  }
}
