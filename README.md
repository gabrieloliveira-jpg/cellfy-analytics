# Cellfy Analytics — SKUs Parados

Sistema de gestão de SKUs parados, construído para GitHub Pages.

## Como publicar no GitHub Pages (5 minutos)

### 1. Crie um repositório no GitHub
- Acesse [github.com](https://github.com) e faça login
- Clique em **New repository** (botão verde)
- Nome sugerido: `sku-analytics`
- Deixe como **Public**
- Clique em **Create repository**

### 2. Faça upload dos arquivos
- Na página do repositório criado, clique em **uploading an existing file**
- Arraste os 3 arquivos: `index.html`, `style.css`, `app.js`
- Clique em **Commit changes**

### 3. Ative o GitHub Pages
- Vá em **Settings** (engrenagem) no repositório
- No menu lateral, clique em **Pages**
- Em **Source**, selecione **Deploy from a branch**
- Branch: **main** / Pasta: **/ (root)**
- Clique em **Save**

### 4. Acesse o site
Após 1-2 minutos, seu site estará em:
```
https://SEU-USUARIO.github.io/sku-analytics/
```

## Funcionalidades

- **SKUs Parados**: lista todos os SKUs com estoque > 0 e zero saída nos últimos 60 dias
- **Trabalhados**: histórico de intervenções com margem, modificação e resultado
- **Resumo Semanal**: quantos SKUs foram mexidos, taxa de conversão por semana
- **Recém Ativos**: SKUs com saída nos últimos 60 dias

## Trocar a planilha

Edite a primeira linha do arquivo `app.js`:
```js
const SHEET_ID = 'SEU_ID_AQUI';
```

O ID está na URL da planilha:
```
https://docs.google.com/spreadsheets/d/ESTE_É_O_ID/edit
```
