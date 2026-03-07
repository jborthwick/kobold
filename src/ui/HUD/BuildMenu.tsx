import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { RoomType } from '../../shared/types';

interface BuildMenuProps {
    activeType: RoomType | null;
}

export function BuildMenu({ activeType }: BuildMenuProps) {
    const [pos, setPos] = useState({ x: 12, y: 60 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [hasMoved, setHasMoved] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);

    const selectRoom = (type: RoomType) => {
        if (activeType === type) {
            bus.emit('buildMode', null);
        } else {
            bus.emit('buildMode', { roomType: type });
        }
    };

    const toggleCollapse = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsCollapsed(!isCollapsed);
    };

    const onHeaderClick = () => {
        if (!hasMoved) {
            setIsCollapsed(!isCollapsed);
        }
    };

    const startDrag = (e: React.MouseEvent) => {
        setIsDragging(true);
        setHasMoved(false);
        setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y });
    };

    useEffect(() => {
        if (!isDragging) return;
        const handleMove = (e: MouseEvent) => {
            const dx = e.clientX - (dragStart.x + pos.x);
            const dy = e.clientY - (dragStart.y + pos.y);
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                setHasMoved(true);
            }
            setPos({
                x: e.clientX - dragStart.x,
                y: e.clientY - dragStart.y,
            });
        };
        const handleUp = () => {
            setIsDragging(false);
        };
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
        return () => {
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
        };
    }, [isDragging, dragStart, pos.x, pos.y]);

    return (
        <div style={{ ...styles.container, left: pos.x, top: pos.y, height: isCollapsed ? 'auto' : undefined }}>
            <div style={styles.header} onMouseDown={startDrag} onClick={onHeaderClick}>
                <span>DESIGNATE ZONE</span>
                <button
                    onClick={toggleCollapse}
                    style={styles.collapseBtn}
                >{isCollapsed ? '□' : '−'}</button>
            </div>

            {!isCollapsed && (
                <>
                    <div style={styles.section}>
                        <div style={styles.sectionLabel}>Storage</div>
                        <button
                            onClick={() => selectRoom('storage')}
                            style={{
                                ...styles.buildBtn,
                                ...(activeType === 'storage' ? styles.buildBtnActive : {})
                            }}
                        >
                            <span style={styles.icon}>📦</span>
                            <div style={styles.btnText}>
                                <div style={styles.btnTitle}>Storage Room</div>
                                <div style={styles.btnDesc}>5×5 zone for stockpiles</div>
                            </div>
                        </button>
                    </div>

                    <div style={styles.section}>
                        <div style={styles.sectionLabel}>Food</div>
                        <button
                            onClick={() => selectRoom('kitchen')}
                            style={{
                                ...styles.buildBtn,
                                ...(activeType === 'kitchen' ? styles.buildBtnActive : {})
                            }}
                        >
                            <span style={styles.icon}>🍳</span>
                            <div style={styles.btnText}>
                                <div style={styles.btnTitle}>Kitchen</div>
                                <div style={styles.btnDesc}>5×5 zone where meals are cooked</div>
                            </div>
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        position: 'absolute',
        top: 60,
        left: 12,
        width: 240,
        background: 'rgba(20, 22, 25, 0.95)',
        border: '1px solid #444',
        borderRadius: 8,
        color: '#eee',
        fontFamily: 'monospace',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        pointerEvents: 'auto',
        zIndex: 1000,
    },
    header: {
        padding: '8px 12px',
        background: 'rgba(255,255,255,0.05)',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 10,
        fontWeight: 'bold',
        letterSpacing: '0.1em',
        color: '#888',
        cursor: 'grab',
        userSelect: 'none',
    },
    collapseBtn: {
        background: 'none',
        border: 'none',
        color: '#888',
        fontSize: 14,
        cursor: 'pointer',
        padding: '0 4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
    },
    section: {
        padding: 12,
    },
    sectionLabel: {
        fontSize: 9,
        color: '#555',
        textTransform: 'uppercase',
        marginBottom: 8,
        fontWeight: 'bold',
    },
    buildBtn: {
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid #333',
        borderRadius: 6,
        cursor: 'pointer',
        textAlign: 'left',
        color: '#ccc',
        transition: 'all 0.1s',
    },
    buildBtnActive: {
        background: 'rgba(0, 200, 80, 0.1)',
        borderColor: '#00c850',
        color: '#fff',
    },
    icon: {
        fontSize: 20,
    },
    btnText: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
    },
    btnTitle: {
        fontSize: 12,
        fontWeight: 'bold',
    },
    btnDesc: {
        fontSize: 9,
        color: '#666',
    },
};
