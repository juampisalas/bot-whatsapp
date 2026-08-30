export class BoundedBuffer<T> {
  private readonly items: T[] = []
  private droppedCount = 0

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('El límite del buffer debe ser un entero positivo')
    }
  }

  get size(): number {
    return this.items.length
  }

  get dropped(): number {
    return this.droppedCount
  }

  push(item: T): void {
    if (this.items.length >= this.limit) {
      this.items.shift()
      this.droppedCount += 1
    }

    this.items.push(item)
  }

  requeueFront(items: readonly T[]): void {
    this.items.unshift(...items)
    const overflow = this.items.length - this.limit
    if (overflow > 0) {
      this.items.splice(0, overflow)
      this.droppedCount += overflow
    }
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length)
  }
}
