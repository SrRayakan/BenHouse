import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Home from './page';

describe('Home', () => {
  it('renderiza el shell técnico de Foundation', () => {
    const markup = renderToStaticMarkup(createElement(Home));

    expect(markup).toContain('BenHouse v0.4');
    expect(markup).toContain('Foundation activa');
  });
});
