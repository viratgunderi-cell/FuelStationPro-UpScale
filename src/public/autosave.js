/**
 * FuelStation Pro - Auto-Save Functionality
 * Automatically saves form data to prevent data loss
 */

class AutoSave {
  constructor(options = {}) {
    this.saveInterval = options.saveInterval || 5000; // 5 seconds default
    this.storageKey = options.storageKey || 'fuelstation_autosave';
    this.forms = new Map();
    this.timers = new Map();
    this.lastSaved = new Map();
    
    console.log('[AutoSave] Initialized');
  }

  /**
   * Enable auto-save for a form
   */
  enable(formId, options = {}) {
    const form = document.getElementById(formId);
    if (!form) {
      console.warn(`[AutoSave] Form not found: ${formId}`);
      return;
    }

    const key = `${this.storageKey}_${formId}`;
    this.forms.set(formId, { form, key, options });

    // Attach change listeners
    const inputs = form.querySelectorAll('input, select, textarea');
    inputs.forEach(input => {
      input.addEventListener('input', () => this.scheduleSave(formId));
      input.addEventListener('change', () => this.scheduleSave(formId));
    });

    // Try to restore saved data
    this.restore(formId);

    console.log(`[AutoSave] Enabled for: ${formId}`);
  }

  /**
   * Schedule a save operation
   */
  scheduleSave(formId) {
    if (this.timers.has(formId)) {
      clearTimeout(this.timers.get(formId));
    }

    const timer = setTimeout(() => {
      this.save(formId);
    }, this.saveInterval);

    this.timers.set(formId, timer);
  }

  /**
   * Save form data to localStorage
   */
  save(formId) {
    const formData = this.forms.get(formId);
    if (!formData) return;

    const { form, key } = formData;
    const data = this.getFormData(form);

    try {
      localStorage.setItem(key, JSON.stringify({
        data,
        timestamp: Date.now(),
        version: '1.0'
      }));

      this.lastSaved.set(formId, Date.now());
      this.showSaveIndicator(formId, 'saved');
      
      console.log(`[AutoSave] Saved: ${formId}`);
    } catch (error) {
      console.error(`[AutoSave] Save error for ${formId}:`, error);
      this.showSaveIndicator(formId, 'error');
    }
  }

  /**
   * Restore saved data
   */
  restore(formId) {
    const formData = this.forms.get(formId);
    if (!formData) return false;

    const { form, key } = formData;

    try {
      const saved = localStorage.getItem(key);
      if (!saved) return false;

      const { data, timestamp } = JSON.parse(saved);
      
      // Check if data is too old (more than 24 hours)
      const age = Date.now() - timestamp;
      if (age > 24 * 60 * 60 * 1000) {
        this.clear(formId);
        return false;
      }

      // Show restore prompt
      const shouldRestore = confirm(
        `Found unsaved data from ${new Date(timestamp).toLocaleString()}.\n\nWould you like to restore it?`
      );

      if (shouldRestore) {
        this.setFormData(form, data);
        console.log(`[AutoSave] Restored: ${formId}`);
        return true;
      } else {
        this.clear(formId);
        return false;
      }
    } catch (error) {
      console.error(`[AutoSave] Restore error for ${formId}:`, error);
      return false;
    }
  }

  /**
   * Get form data as object
   */
  getFormData(form) {
    const data = {};
    const inputs = form.querySelectorAll('input, select, textarea');
    
    inputs.forEach(input => {
      if (input.type === 'checkbox') {
        data[input.name || input.id] = input.checked;
      } else if (input.type === 'radio') {
        if (input.checked) {
          data[input.name || input.id] = input.value;
        }
      } else {
        data[input.name || input.id] = input.value;
      }
    });

    return data;
  }

  /**
   * Set form data from object
   */
  setFormData(form, data) {
    Object.entries(data).forEach(([key, value]) => {
      const input = form.querySelector(`[name="${key}"], #${key}`);
      if (!input) return;

      if (input.type === 'checkbox') {
        input.checked = value;
      } else if (input.type === 'radio') {
        if (input.value === value) {
          input.checked = true;
        }
      } else {
        input.value = value;
      }
    });
  }

  /**
   * Clear saved data
   */
  clear(formId) {
    const formData = this.forms.get(formId);
    if (!formData) return;

    const { key } = formData;
    localStorage.removeItem(key);
    
    console.log(`[AutoSave] Cleared: ${formId}`);
  }

  /**
   * Clear all saved data
   */
  clearAll() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(this.storageKey)) {
        localStorage.removeItem(key);
      }
    });
    
    console.log('[AutoSave] Cleared all saved data');
  }

  /**
   * Show save indicator
   */
  showSaveIndicator(formId, status) {
    // Try to find indicator element
    let indicator = document.getElementById(`autosave-indicator-${formId}`);
    
    if (!indicator) {
      const formData = this.forms.get(formId);
      if (!formData) return;

      // Create indicator if it doesn't exist
      indicator = document.createElement('div');
      indicator.id = `autosave-indicator-${formId}`;
      indicator.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #4CAF50;
        color: white;
        padding: 8px 16px;
        border-radius: 4px;
        font-size: 14px;
        z-index: 10000;
        transition: opacity 0.3s;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      `;
      document.body.appendChild(indicator);
    }

    // Update indicator
    if (status === 'saved') {
      indicator.style.background = '#4CAF50';
      indicator.textContent = '💾 Auto-saved';
    } else if (status === 'saving') {
      indicator.style.background = '#FF9800';
      indicator.textContent = '⏳ Saving...';
    } else if (status === 'error') {
      indicator.style.background = '#f44336';
      indicator.textContent = '❌ Save failed';
    }

    indicator.style.opacity = '1';

    // Hide after 2 seconds
    setTimeout(() => {
      indicator.style.opacity = '0';
    }, 2000);
  }

  /**
   * Disable auto-save for a form
   */
  disable(formId) {
    if (this.timers.has(formId)) {
      clearTimeout(this.timers.get(formId));
      this.timers.delete(formId);
    }

    this.forms.delete(formId);
    this.lastSaved.delete(formId);

    console.log(`[AutoSave] Disabled for: ${formId}`);
  }

  /**
   * Get last save time
   */
  getLastSaveTime(formId) {
    return this.lastSaved.get(formId);
  }

  /**
   * Check if form has unsaved changes
   */
  hasUnsavedChanges(formId) {
    const formData = this.forms.get(formId);
    if (!formData) return false;

    const { form, key } = formData;
    const currentData = this.getFormData(form);

    try {
      const saved = localStorage.getItem(key);
      if (!saved) return false;

      const { data: savedData } = JSON.parse(saved);
      return JSON.stringify(currentData) !== JSON.stringify(savedData);
    } catch {
      return false;
    }
  }
}

// Create global instance
window.autoSave = new AutoSave({
  saveInterval: 5000,
  storageKey: 'fuelstation_autosave'
});

console.log('[AutoSave] Ready - Auto-saves every 5 seconds');
