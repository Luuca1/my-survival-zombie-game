const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) return res.writeHead(500).end('Erro ao carregar index.html');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
const wss = new WebSocket.Server({ server });

const WEAPONS = {
    axe: { damage: 40, cd: 600, bulletSpeed: 0, piercing: false },
    pistol: { damage: 35, cd: 400, bulletSpeed: 15, piercing: false },
    smg: { damage: 12, cd: 100, bulletSpeed: 18, piercing: false },
    rifle: { damage: 100, cd: 900, bulletSpeed: 25, piercing: true },
    sniper: { damage: 250, cd: 1500, bulletSpeed: 35, piercing: true }
};

const ZOMBIE_TYPES = {
    normal: { baseHp: 100, speed: 2.5, damage: 15, radius: 15, type: 'normal' },
    runner: { baseHp: 60, speed: 4.2, damage: 10, radius: 12, type: 'runner' },
    tank:   { baseHp: 300, speed: 1.5, damage: 25, radius: 22, type: 'tank' },
    boss:   { baseHp: 1500, speed: 2.0, damage: 40, radius: 35, type: 'boss' }
};

const GAME = { CHUNK_SIZE: 1000, FPS: 60, PLAYER_SPEED: 4, PLAYER_MAX_HP: 100 };

// GESTÃO DE SALAS (ROOMS)
const rooms = {};

function createInitialState() {
    return {
        players: {}, zombies: {}, bullets: {}, items: {}, obstacles: {}, water: {}, chunks: new Set(),
        gameOver: false, seed: Math.floor(Math.random() * 9999999),
        level: 1, activeBossId: null, nextBossDistance: 1000, password: ''
    };
}

function seededRandom(seed) { let x = Math.sin(seed) * 10000; return x - Math.floor(x); }
function generateId() { return Math.random().toString(36).substr(2, 9); }
function getDist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

function spawnZombie(state, x, y, typeKey, levelMultiplier) {
    const template = ZOMBIE_TYPES[typeKey];
    const id = generateId();
    state.zombies[id] = {
        id: id, x: x, y: y,
        hp: template.baseHp * levelMultiplier, maxHp: template.baseHp * levelMultiplier,
        speed: template.speed + (Math.random() * 0.5),
        damage: template.damage, radius: template.radius,
        type: template.type, angle: Math.random() * Math.PI * 2
    };
    return id;
}

function generateChunkIfNeeded(state, playerX, playerY) {
    const pcx = Math.floor(playerX / GAME.CHUNK_SIZE);
    const pcy = Math.floor(playerY / GAME.CHUNK_SIZE);

    for (let offsetX = -1; offsetX <= 1; offsetX++) {
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
            const cx = pcx + offsetX; const cy = pcy + offsetY;
            const chunkKey = `${cx},${cy}`;
            if (state.chunks.has(chunkKey)) continue;
            state.chunks.add(chunkKey);
            let chunkSeed = state.seed + (cx * 1337) + (cy * 99991);

            const numTrees = Math.floor(seededRandom(chunkSeed++) * 8) + 4;
            for (let i = 0; i < numTrees; i++) {
                state.obstacles[generateId()] = { 
                    x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, 
                    y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, 
                    radius: 25 + seededRandom(chunkSeed++) * 10, type: 'tree', hp: 100
                };
            }

            if (seededRandom(chunkSeed++) > 0.6) {
                state.water[generateId()] = {
                    x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, 
                    y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, radius: 80 + seededRandom(chunkSeed++) * 40
                };
            }

            if (seededRandom(chunkSeed++) > 0.7) {
                let hx = cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE;
                let hy = cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE;
                state.items[generateId()] = { x: hx, y: hy, type: 'bed' };
            }

            if (seededRandom(chunkSeed++) > 0.4) state.items[generateId()] = { x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, type: 'mushroom' };
            if (seededRandom(chunkSeed++) > 0.6) state.items[generateId()] = { x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, type: 'canned_food' };
            if (seededRandom(chunkSeed++) > 0.7) state.items[generateId()] = { x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, type: 'soda' };
            if (seededRandom(chunkSeed++) > 0.85) state.items[generateId()] = { x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, type: 'armor' };
            if (seededRandom(chunkSeed++) > 0.5) state.items[generateId()] = { x: cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, y: cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE, type: 'ammo' };

            const numZombies = Math.floor(seededRandom(chunkSeed++) * 6) + 3;
            const levelMult = 1 + ((state.level - 1) * 0.3);

            for (let i = 0; i < numZombies; i++) {
                let zx = cx * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE;
                let zy = cy * GAME.CHUNK_SIZE + seededRandom(chunkSeed++) * GAME.CHUNK_SIZE;
                let tooClose = false;
                for (const pid in state.players) {
                    if (!state.players[pid].isDead && getDist(zx, zy, state.players[pid].x, state.players[pid].y) < 1200) { tooClose = true; break; }
                }
                if (!tooClose) {
                    let type = 'normal'; const rand = seededRandom(chunkSeed++);
                    if (state.level > 1 && rand > 0.7) type = 'runner';
                    if (state.level > 2 && rand > 0.9) type = 'tank';
                    spawnZombie(state, zx, zy, type, levelMult);
                }
            }
        }
    }
}

function dropItemFromZombie(state, x, y, isBoss) {
    state.items[generateId()] = { x: x + (Math.random() * 10 - 5), y: y + (Math.random() * 10 - 5), type: 'ammo' };

    if (isBoss) {
        state.items[generateId()] = { x: x + 20, y: y, type: 'medkit' };
        state.items[generateId()] = { x: x - 20, y: y, type: 'sniper_drop' }; 
        state.items[generateId()] = { x: x, y: y + 20, type: 'armor' }; 
        return;
    }

    const roll = Math.random();
    if (roll < 0.10) state.items[generateId()] = { x, y, type: 'mushroom' };
    else if (roll < 0.15) state.items[generateId()] = { x, y, type: 'canned_food' };
    else if (roll < 0.20) state.items[generateId()] = { x, y, type: 'soda' };
    else if (roll < 0.25) state.items[generateId()] = { x, y, type: 'bandage' };
    else if (roll < 0.27) state.items[generateId()] = { x, y, type: 'medkit' };
    else if (roll < 0.29) state.items[generateId()] = { x, y, type: 'armor' }; 
    else if (roll < 0.31) state.items[generateId()] = { x, y, type: 'smg_drop' };
    else if (roll < 0.32) state.items[generateId()] = { x, y, type: 'rifle_drop' };
    else if (roll < 0.325) state.items[generateId()] = { x, y, type: 'sniper_drop' }; 
}

function handleZombieDeath(state, zid, z) {
    const isBoss = (z.type === 'boss');
    dropItemFromZombie(state, z.x, z.y, isBoss);
    delete state.zombies[zid];
    if (isBoss && state.activeBossId === zid) state.activeBossId = null; 
    state.kills = (state.kills || 0) + 1;
    if (state.kills % 30 === 0) {
        state.level++;
        for (const pid in state.players) {
            if (!state.players[pid].isDead) {
                state.activeBossId = spawnZombie(state, state.players[pid].x + 300, state.players[pid].y + 300, 'boss', 1 + (state.level*0.5));
                break;
            }
        }
    }
}

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                const roomId = data.room || 'default';
                const pass = data.password || '';

                if (!rooms[roomId]) {
                    rooms[roomId] = createInitialState();
                    rooms[roomId].password = pass;
                } else if (rooms[roomId].password && rooms[roomId].password !== pass) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Senha incorreta para a sala!' }));
                    return;
                }

                const playerId = generateId();
                ws.playerId = playerId;
                ws.roomId = roomId;
                ws.playerName = data.name.substring(0, 15);

                ws.send(JSON.stringify({ type: 'init', id: playerId }));

                const state = rooms[roomId];
                if (state.gameOver || Object.keys(state.players).length === 0) {
                    const oldPass = state.password;
                    rooms[roomId] = createInitialState();
                    rooms[roomId].password = oldPass;
                }

                rooms[roomId].players[playerId] = {
                    id: playerId, name: ws.playerName,
                    x: 0, y: 0, moveX: 0, moveY: 0, angle: 0, 
                    hp: GAME.PLAYER_MAX_HP, maxHp: GAME.PLAYER_MAX_HP, isDead: false,
                    hunger: 100, thirst: 100, sleep: 100, wood: 0, 
                    ammo: 30, bandages: 0, medkits: 1, armorHits: 0, 
                    ownedWeapons: ['pistol', 'axe'],
                    weapon: 'pistol', lastShot: 0 
                };
            }
            else if (data.type === 'chat') {
                const payload = JSON.stringify({ type: 'chat', sender: ws.playerName || 'Anônimo', text: data.text });
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(payload);
                });
            }
            else {
                if (!ws.roomId || !rooms[ws.roomId]) return;
                const state = rooms[ws.roomId];
                const player = state.players[ws.playerId];
                if (!player) return;
                if (player.isDead && data.type !== 'move') return; 

                const now = Date.now();

                switch (data.type) {
                    case 'move': player.moveX = data.vx; player.moveY = data.vy; if (data.angle !== undefined) player.angle = data.angle; break;
                    
                    case 'equip': 
                        if (data.weapon && player.ownedWeapons.includes(data.weapon)) {
                            player.weapon = data.weapon;
                        }
                        break;

                    case 'shoot':
                        if (player.weapon === 'axe') return; 
                        const wpn = WEAPONS[player.weapon];
                        if (player.ammo > 0 && now - player.lastShot >= wpn.cd) {
                            player.ammo--; player.lastShot = now;
                            state.bullets[generateId()] = {
                                x: player.x, y: player.y,
                                vx: Math.cos(player.angle) * wpn.bulletSpeed, vy: Math.sin(player.angle) * wpn.bulletSpeed,
                                owner: ws.playerId, life: 80, damage: wpn.damage, piercing: wpn.piercing, hitList: [] 
                            };
                        }
                        break;

                    case 'melee': 
                        const meleeRange = 60;
                        const meleeDamage = player.weapon === 'axe' ? WEAPONS.axe.damage : 20;

                        for (const zid in state.zombies) {
                            const z = state.zombies[zid];
                            if (getDist(player.x, player.y, z.x, z.y) <= meleeRange) {
                                const zAngle = Math.atan2(z.y - player.y, z.x - player.x);
                                if (Math.abs(zAngle - player.angle) < 1.0) {
                                    z.hp -= meleeDamage;
                                    if (z.hp <= 0) handleZombieDeath(state, zid, z);
                                }
                            }
                        }

                        if (player.weapon === 'axe') {
                            for (const oid in state.obstacles) {
                                const obs = state.obstacles[oid];
                                if (obs.type === 'tree' && getDist(player.x, player.y, obs.x, obs.y) <= meleeRange + obs.radius) {
                                    const oAngle = Math.atan2(obs.y - player.y, obs.x - player.x);
                                    if (Math.abs(oAngle - player.angle) < 1.0) {
                                        obs.hp -= 35;
                                        if (obs.hp <= 0) {
                                            player.wood += Math.floor(Math.random() * 3) + 2; 
                                            delete state.obstacles[oid];
                                        }
                                    }
                                }
                            }
                        }
                        break;

                    case 'build':
                        if (player.wood >= 5) {
                            player.wood -= 5;
                            const bx = player.x + Math.cos(player.angle) * 60;
                            const by = player.y + Math.sin(player.angle) * 60;
                            state.obstacles[generateId()] = { x: bx, y: by, radius: 20, type: 'barricade', hp: 200, angle: player.angle };
                        }
                        break;

                    case 'interact':
                        for (const wid in state.water) {
                            if (getDist(player.x, player.y, state.water[wid].x, state.water[wid].y) < state.water[wid].radius + 30) player.thirst = 100;
                        }
                        for (const iid in state.items) {
                            const item = state.items[iid];
                            if (getDist(player.x, player.y, item.x, item.y) < 40) {
                                let consumed = true;
                                if (item.type === 'mushroom') { player.hunger = Math.min(100, player.hunger + 30); }
                                else if (item.type === 'canned_food') { player.hunger = Math.min(100, player.hunger + 60); player.hp = Math.min(player.maxHp, player.hp + 10); }
                                else if (item.type === 'soda') { player.thirst = 100; player.sleep = Math.min(100, player.sleep + 20); }
                                else if (item.type === 'bed') { player.sleep = 100; consumed = false; }
                                else if (item.type === 'armor') { player.armorHits = 20; }
                                else if (item.type === 'ammo') { player.ammo += 15; }
                                else if (item.type === 'bandage') { player.bandages += 1; }
                                else if (item.type === 'medkit') { player.medkits += 1; }
                                else if (item.type === 'smg_drop') { 
                                    if(!player.ownedWeapons.includes('smg')) player.ownedWeapons.push('smg'); 
                                    player.weapon = 'smg'; 
                                }
                                else if (item.type === 'rifle_drop') { 
                                    if(!player.ownedWeapons.includes('rifle')) player.ownedWeapons.push('rifle'); 
                                    player.weapon = 'rifle'; 
                                }
                                else if (item.type === 'sniper_drop') { 
                                    if(!player.ownedWeapons.includes('sniper')) player.ownedWeapons.push('sniper'); 
                                    player.weapon = 'sniper'; 
                                }
                                
                                if(consumed) delete state.items[iid];
                            }
                        }
                        break;

                    case 'heal': if (player.bandages > 0 && player.hp < player.maxHp) { player.bandages--; player.hp = Math.min(player.maxHp, player.hp + 40); } break;
                    case 'revive': 
                        if (player.medkits > 0) {
                            let closest = null; let minDist = 100; 
                            for (const pid in state.players) {
                                if (pid !== ws.playerId && state.players[pid].isDead && getDist(player.x, player.y, state.players[pid].x, state.players[pid].y) < minDist) {
                                    minDist = getDist(player.x, player.y, state.players[pid].x, state.players[pid].y); closest = state.players[pid];
                                }
                            }
                            if (closest) { player.medkits--; closest.isDead = false; closest.hp = closest.maxHp / 2; }
                        }
                        break;
                }
            }
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => {
        if (ws.roomId && rooms[ws.roomId] && ws.playerId) {
            delete rooms[ws.roomId].players[ws.playerId];
        }
    });
});


setInterval(() => {
    const now = Date.now();
    
    for (const roomId in rooms) {
        const state = rooms[roomId];
        let aliveCount = 0;
        let currentMaxDist = 0;
        let furthestPlayer = null;

        for (const pid in state.players) {
            const p = state.players[pid];
            if (!p.isDead) {
                aliveCount++;
                const dFromCenter = Math.hypot(p.x, p.y);
                if (dFromCenter > currentMaxDist) {
                    currentMaxDist = dFromCenter;
                    furthestPlayer = p;
                }
            }
            
            generateChunkIfNeeded(state, p.x, p.y);

            if (!p.isDead) {
                p.hunger = Math.max(0, p.hunger - 0.015);
                p.thirst = Math.max(0, p.thirst - 0.025);
                p.sleep = Math.max(0, p.sleep - 0.008);
                if (p.hunger === 0 || p.thirst === 0 || p.sleep === 0) {
                    p.hp -= 0.05;
                    if (p.hp <= 0) { p.hp = 0; p.isDead = true; }
                }
            }

            if (p.moveX !== 0 || p.moveY !== 0) {
                const mag = Math.hypot(p.moveX, p.moveY);
                const speed = p.isDead ? GAME.PLAYER_SPEED * 1.5 : GAME.PLAYER_SPEED; 
                let nextX = p.x + (p.moveX / mag) * speed;
                let nextY = p.y + (p.moveY / mag) * speed;

                if (!p.isDead) {
                    for (const oid in state.obstacles) {
                        const obs = state.obstacles[oid];
                        const dObs = getDist(nextX, nextY, obs.x, obs.y);
                        const colRadius = (obs.radius * 0.6) + 12; 
                        if (dObs < colRadius) {
                            const overlap = colRadius - dObs;
                            nextX += (nextX - obs.x) / dObs * overlap;
                            nextY += (nextY - obs.y) / dObs * overlap;
                        }
                    }
                }
                p.x = nextX; p.y = nextY;
            }
        }

        const calculatedLevel = Math.floor(currentMaxDist / 500) + 1;
        if (calculatedLevel > state.level) state.level = calculatedLevel;

        if (currentMaxDist >= state.nextBossDistance && furthestPlayer && !state.activeBossId) {
            const bossLevel = Math.floor(state.nextBossDistance / 1000);
            state.activeBossId = spawnZombie(state, furthestPlayer.x + 300, furthestPlayer.y + 300, 'boss', bossLevel);
            state.nextBossDistance += 1000;
        }

        if (Object.keys(state.players).length > 0 && aliveCount === 0) state.gameOver = true;

        for (const zid in state.zombies) {
            const z = state.zombies[zid];
            let target = null; let minHp = Infinity; let minHpDist = Infinity;

            for (const pid in state.players) {
                const p = state.players[pid];
                if (p.isDead) continue; 
                const d = getDist(z.x, z.y, p.x, p.y);
                if (d < (z.type === 'boss' ? 800 : 400)) { 
                    const angleDiff = Math.abs(Math.atan2(p.y - z.y, p.x - z.x) - z.angle);
                    const normAngle = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
                    if (normAngle < 1.5 || d < 100) {
                        if (p.hp < minHp) { minHp = p.hp; minHpDist = d; target = p; } 
                    }
                }
            }

            let barricadeTarget = null;
            if (!target) {
                for (const oid in state.obstacles) {
                    const obs = state.obstacles[oid];
                    if (obs.type === 'barricade' && getDist(z.x, z.y, obs.x, obs.y) < 100) {
                        barricadeTarget = obs; barricadeTarget.id = oid; break;
                    }
                }
            }

            if (target || barricadeTarget) {
                const tX = target ? target.x : barricadeTarget.x;
                const tY = target ? target.y : barricadeTarget.y;
                const d = getDist(z.x, z.y, tX, tY);
                const moveX = (tX - z.x) / d; const moveY = (tY - z.y) / d;
                z.angle = Math.atan2(moveY, moveX);

                if (d > z.radius + 15) {
                    let nextX = z.x + moveX * z.speed; let nextY = z.y + moveY * z.speed;
                    for (const oid in state.obstacles) {
                        const obs = state.obstacles[oid];
                        if (barricadeTarget && oid === barricadeTarget.id) continue; 
                        const dObs = getDist(nextX, nextY, obs.x, obs.y);
                        if (dObs < (obs.radius * 0.6) + z.radius) {
                            const overlap = ((obs.radius * 0.6) + z.radius) - dObs;
                            nextX += (nextX - obs.x) / dObs * overlap; nextY += (nextY - obs.y) / dObs * overlap;
                        }
                    }
                    z.x = nextX; z.y = nextY;
                } else {
                    if (target) {
                        let dmg = z.damage;
                        if (target.armorHits > 0) {
                            dmg = dmg * 0.5; 
                            target.armorHits--;
                        }
                        target.hp -= dmg;
                        if (target.hp <= 0) { target.hp = 0; target.isDead = true; }
                    } else if (barricadeTarget) {
                        barricadeTarget.hp -= z.damage;
                        if (barricadeTarget.hp <= 0) delete state.obstacles[barricadeTarget.id];
                    }
                    z.x -= moveX * 20; z.y -= moveY * 20; 
                }
            } else {
                z.x += Math.cos(z.angle) * (z.speed * 0.15); z.y += Math.sin(z.angle) * (z.speed * 0.15);
                if (Math.random() < 0.03) z.angle += (Math.random() - 0.5) * 1.5;
            }
        }

        for (const bid in state.bullets) {
            const b = state.bullets[bid];
            b.x += b.vx; b.y += b.vy; b.life--;

            let destroyed = false;
            for (const zid in state.zombies) {
                const z = state.zombies[zid];
                if (b.hitList.includes(zid)) continue; 
                if (getDist(b.x, b.y, z.x, z.y) < z.radius + 5) {
                    z.hp -= b.damage; 
                    if (z.hp <= 0) handleZombieDeath(state, zid, z);
                    b.hitList.push(zid);
                    if (!b.piercing) destroyed = true; 
                    break;
                }
            }

            if (!destroyed) {
                for (const oid in state.obstacles) {
                    const obs = state.obstacles[oid];
                    if (getDist(b.x, b.y, obs.x, obs.y) < obs.radius * 0.6 + 5) { destroyed = true; break; }
                }
            }
            if (destroyed || b.life <= 0) delete state.bullets[bid];
        }

        // Transmitir apenas para os jogadores daquela sala
        const payload = JSON.stringify({ type: 'gameState', state: state });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
                client.send(payload);
            }
        });
    }
}, 1000 / GAME.FPS);