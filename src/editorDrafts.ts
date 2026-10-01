/** Keeps an editor's drafts intact across refreshes and asynchronous saves. */
export class EditorDrafts<Key> {
  private readonly dirty = new Set<Key>();
  private readonly saving = new Set<Key>();

  get hasPending(): boolean { return this.dirty.size > 0 || this.isSaving; }
  get isSaving(): boolean { return this.saving.size > 0; }

  markDirty(key: Key): void { this.dirty.add(key); }
  cancel(key: Key): void { if (!this.saving.has(key)) this.dirty.delete(key); }
  clear(): void { this.dirty.clear(); this.saving.clear(); }

  beginSave(key: Key): boolean {
    if (this.isSaving || !this.dirty.has(key)) return false;
    this.saving.add(key);
    return true;
  }

  finishSave(key: Key, success: boolean): void {
    this.saving.delete(key);
    if (success) this.dirty.delete(key);
  }
}
