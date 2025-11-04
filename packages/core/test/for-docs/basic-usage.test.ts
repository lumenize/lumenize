/**
 * Pedagogical tests for @lumenize/core documentation examples
 * These tests are referenced in website/docs/core/*.mdx files
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { env } from 'cloudflare:test';
import { DurableObject } from 'cloudflare:workers';
import { sql } from '@lumenize/core';

// Example: Standalone usage
class ProductDO extends DurableObject {
  #sql = sql(this);

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    // Run migrations in constructor
    this.#sql`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        stock INTEGER DEFAULT 0
      )
    `;
  }

  addProduct(id: string, name: string, price: number, stock: number = 0) {
    this.#sql`
      INSERT INTO products (id, name, price, stock)
      VALUES (${id}, ${name}, ${price}, ${stock})
    `;
    return { id, name, price, stock };
  }

  getProduct(id: string) {
    const rows = this.#sql`SELECT * FROM products WHERE id = ${id}`;
    return rows[0];
  }

  updateStock(id: string, quantity: number) {
    this.#sql`UPDATE products SET stock = stock + ${quantity} WHERE id = ${id}`;
  }

  getLowStockProducts(threshold: number = 10) {
    return this.#sql`
      SELECT id, name, stock FROM products 
      WHERE stock < ${threshold}
      ORDER BY stock ASC
    `;
  }
}

export { ProductDO };

describe('SQL Injectable - Basic Usage', () => {
  it('creates table and inserts products', async () => {
    const stub = env.PRODUCT_DO.getByName('products-test');
    
    const product = await stub.addProduct('p1', 'Widget', 29.99, 100);
    
    expect(product.name).toBe('Widget');
    expect(product.price).toBe(29.99);
  });

  it('queries with template literal parameters', async () => {
    const stub = env.PRODUCT_DO.getByName('query-test');
    
    await stub.addProduct('p1', 'Gadget', 49.99, 5);
    await stub.addProduct('p2', 'Doohickey', 19.99, 50);
    
    const product = await stub.getProduct('p1');
    expect(product.name).toBe('Gadget');
  });

  it('handles complex queries', async () => {
    const stub = env.PRODUCT_DO.getByName('complex-query-test');
    
    await stub.addProduct('p1', 'Widget', 29.99, 5);
    await stub.addProduct('p2', 'Gadget', 49.99, 2);
    await stub.addProduct('p3', 'Thing', 9.99, 50);
    
    const lowStock = await stub.getLowStockProducts(10);
    expect(lowStock.length).toBe(2);
    expect(lowStock[0].stock).toBeLessThan(10);
  });
});

