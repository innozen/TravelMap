const MAP_URL = 'https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2013/json/skorea_municipalities_topo_simple.json';

// LocalStorage key
const STORAGE_KEY = 'travel_map_data';

// App state
let visitedRegions = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
let currentActiveRegion = null;
let currentActiveRegionName = '';
let koreaGeojson = null;
let pendingUploadedPhoto = null;

// DOM Elements
const svg = d3.select("#korea-map");
const tooltip = d3.select("#map-tooltip");
const loadingEl = document.getElementById('loading');
const visitedCountEl = document.getElementById('visited-count');

// Modal Elements
const modal = document.getElementById('travel-modal');
const closeModalBtn = document.getElementById('close-modal');
const regionNameTitle = document.getElementById('region-name');
const viewMode = document.getElementById('view-mode');
const editMode = document.getElementById('edit-mode');

// List Modal Elements
const listModal = document.getElementById('list-modal');
const closeListModalBtn = document.getElementById('close-list-modal');
const visitedListContainer = document.getElementById('visited-list-container');
const statsBtn = document.getElementById('stats-btn');
const clearAllBtn = document.getElementById('clear-all-btn');

// Form Elements
const travelForm = document.getElementById('travel-form');
const travelDateInput = document.getElementById('travel-date');
const companionsInput = document.getElementById('companions');
const notesInput = document.getElementById('travel-notes');
const photoUrlInput = document.getElementById('photo-url');
const deleteRecordBtn = document.getElementById('delete-record-btn');
const photoUploadInput = document.getElementById('photo-upload-input');
const uploadPhotoBtn = document.getElementById('upload-photo-btn');
const uploadPreviewContainer = document.getElementById('upload-preview-container');
const uploadPreview = document.getElementById('upload-preview');

// View Elements
const viewDate = document.getElementById('view-date');
const viewCompanions = document.getElementById('view-companions');
const viewNotes = document.getElementById('view-notes');
const viewPhoto = document.getElementById('view-photo');
const photoBox = document.getElementById('photo-box');
const editRecordBtn = document.getElementById('edit-record-btn');

// Initialization
async function initMap() {
    updateVisitedCount();

    try {
        const topoData = await d3.json(MAP_URL);

        // Process TopoJSON to merge 'Gu' into 'Si'
        const geometries = topoData.objects.skorea_municipalities_geo.geometries;
        const groupedGeoms = {};
        const codeToMergedCodeMap = {}; // For migrating old saved data

        const METRO_CITIES = {
            '11': '서울특별시',
            '21': '부산광역시',
            '22': '대구광역시',
            '23': '인천광역시',
            '24': '광주광역시',
            '25': '대전광역시',
            '26': '울산광역시',
            '29': '세종특별자치시'
        };

        geometries.forEach(g => {
            let name = g.properties.name;
            let code = g.properties.code.toString();
            let prefix = code.substring(0, 2);

            let mergedName = name;
            let mergedCode = code;

            if (METRO_CITIES[prefix]) {
                // If it's a Metro City and it's a Gu (not a Gun like 기장군)
                if (name.endsWith('구')) {
                    mergedName = METRO_CITIES[prefix];
                    mergedCode = prefix;
                } else if (name === METRO_CITIES[prefix]) {
                    mergedName = METRO_CITIES[prefix];
                    mergedCode = prefix;
                }
            } else {
                // Provinces (31-39): group Gu into Si (e.g. 수원시 영통구 -> 수원시)
                let cleanName = name.replace(/\s+/g, '');
                let match = cleanName.match(/^(.+시)(.+구)$/);
                if (match) {
                    mergedName = match[1]; // e.g. "수원시"
                    mergedCode = match[1];
                } else if (name.split(' ').length > 1) {
                    // Fallback for names separated by space like "포항시 남구"
                    let parts = name.split(' ');
                    if (parts[1].endsWith('구')) {
                        mergedName = parts[0];
                        mergedCode = parts[0];
                    }
                }
            }

            if (!groupedGeoms[mergedCode]) {
                groupedGeoms[mergedCode] = {
                    name: mergedName,
                    geometries: []
                };
            }
            groupedGeoms[mergedCode].geometries.push(g);
            codeToMergedCodeMap[code] = mergedCode;
            codeToMergedCodeMap[name] = mergedCode; // mapping by old name just in case
        });

        // Convert merged group geometries back into GeoJSON Features
        const features = Object.keys(groupedGeoms).map(code => {
            const group = groupedGeoms[code];
            const mergedGeometry = topojson.merge(topoData, group.geometries);
            return {
                type: "Feature",
                properties: {
                    code: code, // This might be a string like "수원시" now
                    name: group.name
                },
                geometry: mergedGeometry
            };
        });

        const geojson = {
            type: "FeatureCollection",
            features: features
        };
        koreaGeojson = geojson;

        // Migrate Old LocalStorage Data 
        // Handles cases where a user saved "수원시 장안구" (code 31110) before this update.
        let dataChanged = false;
        for (const oldCode in visitedRegions) {
            const newCode = codeToMergedCodeMap[oldCode];
            if (newCode && newCode !== oldCode) {
                if (!visitedRegions[newCode]) {
                    visitedRegions[newCode] = visitedRegions[oldCode];
                    visitedRegions[newCode].name = groupedGeoms[newCode].name;
                }
                delete visitedRegions[oldCode];
                dataChanged = true;
            }
        }
        if (dataChanged) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(visitedRegions));
            updateVisitedCount();
        }

        // Wait for container dimensions to handle responsive projection
        const container = document.querySelector('.map-container');
        const width = container.clientWidth;
        const height = container.clientHeight;

        // Setup Projection
        const projection = d3.geoMercator()
            .fitSize([width, height], geojson);

        const path = d3.geoPath().projection(projection);

        // Create an inner group for zooming/panning
        const g = svg.append("g");

        // Setup zoom
        const zoom = d3.zoom()
            .scaleExtent([1, 8])
            .on("zoom", (event) => {
                g.attr("transform", event.transform);
            });

        svg.call(zoom);

        // Draw Map
        g.selectAll("path")
            .data(geojson.features)
            .enter()
            .append("path")
            .attr("d", path)
            .attr("class", "region")
            .attr("id", d => `region-${d.properties.code.toString().replace(/\s+/g, '-')}`) // Using code as unique ID for sigun
            .style("fill", d => getRegionColor(d.properties.code))
            .on("mouseover", function (event, d) {
                // Dim other regions
                d3.selectAll(".region").transition().duration(200).style("opacity", 0.5);
                d3.select(this).transition().duration(200).style("opacity", 1);

                // Show Tooltip
                const regionName = d.properties.name;
                const isVisited = visitedRegions[d.properties.code] ? '📍 방문함' : '';

                tooltip.transition().duration(200).style("opacity", 1);
                tooltip.html(`<strong>${regionName}</strong><br/>${isVisited}`)
                    .style("left", (event.pageX) + "px")
                    .style("top", (event.pageY - 28) + "px");
            })
            .on("mousemove", function (event) {
                tooltip.style("left", (event.pageX) + "px")
                    .style("top", (event.pageY - 28) + "px");
            })
            .on("mouseout", function () {
                // Restore opacities
                d3.selectAll(".region").transition().duration(200).style("opacity", 1);

                // Hide Tooltip
                tooltip.transition().duration(500).style("opacity", 0);
            })
            .on("click", function (event, d) {
                handleRegionClick(d.properties.code, d.properties.name);
                // Stop zooming event propagation if wanted
                event.stopPropagation();
            });

        loadingEl.style.display = 'none';

        // Window resize handler to reposition map
        window.addEventListener('resize', () => {
            const newWidth = container.clientWidth;
            const newHeight = container.clientHeight;
            projection.fitSize([newWidth, newHeight], geojson);
            g.selectAll("path").attr("d", path);
        });

    } catch (error) {
        console.error("Error loading map data:", error);
        loadingEl.textContent = "Error loading map. Please try again later.";
    }
}

// Map Logic
function getRegionColor(regionId) {
    if (visitedRegions[regionId] && visitedRegions[regionId].color) {
        return visitedRegions[regionId].color;
    }
    return null;
}

function generateRandomColor() {
    const hue = Math.floor(Math.random() * 360);
    // Vibrant colors matching the glassmorphism theme
    return `hsl(${hue}, 75%, 60%)`;
}

function updateVisitedCount() {
    visitedCountEl.textContent = Object.keys(visitedRegions).length;
}

function updateMapFill() {
    d3.selectAll(".region")
        .transition()
        .duration(500)
        .style("fill", d => getRegionColor(d.properties.code));
}

// Event Handlers
function handleRegionClick(regionId, regionName) {
    currentActiveRegion = regionId;
    currentActiveRegionName = regionName;
    regionNameTitle.textContent = regionName;

    if (visitedRegions[regionId]) {
        showViewMode();
    } else {
        showEditMode();
    }

    openModal();
}

function openModal() {
    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
    currentActiveRegion = null;
    currentActiveRegionName = '';
}

// Modal View switching
function showViewMode() {
    const data = visitedRegions[currentActiveRegion];

    viewDate.textContent = new Date(data.date).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    viewCompanions.textContent = data.companions || 'None specified';

    if (data.notes) {
        viewNotes.textContent = data.notes;
        viewNotes.parentElement.classList.remove('hidden');
    } else {
        viewNotes.textContent = '';
        viewNotes.parentElement.classList.add('hidden');
    }

    if (data.photoUrl) {
        viewPhoto.src = data.photoUrl;
        photoBox.classList.remove('hidden');
    } else {
        photoBox.classList.add('hidden');
        viewPhoto.src = '';
    }

    viewMode.classList.remove('hidden');
    editMode.classList.add('hidden');
}

function showEditMode(isEditing = false, autofillData = null) {
    uploadPreviewContainer.classList.add('hidden');
    pendingUploadedPhoto = null;
    uploadPreview.src = '';

    if (autofillData) {
        travelDateInput.value = autofillData.date || '';
        companionsInput.value = '';
        notesInput.value = '';
        photoUrlInput.value = '';
        if (autofillData.photoData) {
            pendingUploadedPhoto = autofillData.photoData;
            uploadPreview.src = autofillData.photoData;
            uploadPreviewContainer.classList.remove('hidden');
        }
        deleteRecordBtn.classList.add('hidden');
    } else if (isEditing) {
        const data = visitedRegions[currentActiveRegion];
        travelDateInput.value = data.date;
        companionsInput.value = data.companions || '';
        notesInput.value = data.notes || '';

        if (data.photoUrl && data.photoUrl.startsWith('data:image')) {
            uploadPreview.src = data.photoUrl;
            uploadPreviewContainer.classList.remove('hidden');
            photoUrlInput.value = '';
            pendingUploadedPhoto = data.photoUrl;
        } else {
            photoUrlInput.value = data.photoUrl || '';
        }
        deleteRecordBtn.classList.remove('hidden');
    } else {
        travelForm.reset();
        travelDateInput.valueAsDate = new Date();
        deleteRecordBtn.classList.add('hidden');
    }

    viewMode.classList.add('hidden');
    editMode.classList.remove('hidden');
}

// Form Submissions
travelForm.addEventListener('submit', (e) => {
    e.preventDefault();

    // Create new data object
    const newData = {
        name: currentActiveRegionName, // Store the name for the list view
        date: travelDateInput.value,
        companions: companionsInput.value,
        notes: notesInput.value,
        photoUrl: pendingUploadedPhoto || photoUrlInput.value,
        // Keep existing color if editing, otherwise generate a new one
        color: visitedRegions[currentActiveRegion]?.color || generateRandomColor()
    };

    // Save state
    visitedRegions[currentActiveRegion] = newData;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visitedRegions));

    // Update UI
    updateVisitedCount();
    updateMapFill();

    // Switch to view mode to show the saved data
    showViewMode();
});

// Button Actions
closeModalBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
});

editRecordBtn.addEventListener('click', () => {
    showEditMode(true);
});

deleteRecordBtn.addEventListener('click', () => {
    if (confirm(`Are you sure you want to delete your travel record for ${currentActiveRegionName}?`)) {
        delete visitedRegions[currentActiveRegion];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(visitedRegions));

        updateVisitedCount();
        updateMapFill();
        closeModal();
    }
});

document.querySelectorAll('.edit-field-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetId = e.currentTarget.getAttribute('data-target');
        showEditMode(true);
        setTimeout(() => {
            if (targetId === 'photo-upload-input') {
                photoUploadInput.click();
            } else {
                const targetInput = document.getElementById(targetId);
                if (targetInput) {
                    targetInput.focus();
                }
            }
        }, 50);
    });
});

// List Modal Logic
statsBtn.addEventListener('click', () => {
    // Populate the list
    visitedListContainer.innerHTML = '';

    const regions = Object.keys(visitedRegions);

    if (regions.length === 0) {
        visitedListContainer.innerHTML = '<li style="text-align: center; color: var(--text-secondary); padding: 2rem 0;">No places visited yet. Start clicking the map!</li>';
    } else {
        regions.forEach(regionId => {
            const data = visitedRegions[regionId];

            // Handle older data that might not have a name saved
            let regionName = data.name;
            if (!regionName || regionName === 'undefined') {
                const pathNode = document.getElementById(`region-${regionId.toString().replace(/\s+/g, '-')}`);
                if (pathNode) {
                    const datum = d3.select(pathNode).datum();
                    regionName = datum ? datum.properties.name : '알 수 없는 지역';
                } else {
                    regionName = '알 수 없는 지역';
                }
            }

            const li = document.createElement('li');
            li.className = 'visited-list-item';

            const dateStr = new Date(data.date).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

            li.innerHTML = `
                <div class="item-info">
                    <h3>${regionName}</h3>
                    <p>${dateStr} ${data.companions ? `• ${data.companions}` : ''}</p>
                </div>
                <div class="item-color" style="background-color: ${data.color}"></div>
            `;

            // Allow clicking the list item to open the main modal for that region
            li.addEventListener('click', () => {
                listModal.classList.remove('active');
                handleRegionClick(regionId, regionName);
            });

            visitedListContainer.appendChild(li);
        });
    }

    listModal.classList.add('active');
});

closeListModalBtn.addEventListener('click', () => {
    listModal.classList.remove('active');
});

listModal.addEventListener('click', (e) => {
    if (e.target === listModal) listModal.classList.remove('active');
});

clearAllBtn.addEventListener('click', () => {
    if (confirm('정말로 모든 방문 기록을 초기화하시겠습니까?\\n이 작업은 되돌릴 수 없습니다.')) {
        visitedRegions = {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify(visitedRegions));

        updateVisitedCount();
        updateMapFill();
        listModal.classList.remove('active');
    }
});

// EXIF & Upload Logic
uploadPhotoBtn.addEventListener('click', () => {
    photoUploadInput.click();
});

photoUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadPhotoBtn.textContent = '위치 찾는 중...';

    try {
        const exif = await exifr.parse(file);

        if (!exif || !exif.latitude || !exif.longitude) {
            alert('사진에서 위치(GPS) 정보를 찾을 수 없거나 접근 권한이 없습니다.');
            return;
        }

        let foundFeature = null;
        for (const feature of koreaGeojson.features) {
            if (d3.geoContains(feature, [parseFloat(exif.longitude), parseFloat(exif.latitude)])) {
                foundFeature = feature;
                break;
            }
        }

        if (!foundFeature) {
            alert('사진의 위치가 대한민국 지도(시군구) 내에서 검색되지 않습니다.');
            return;
        }

        const regionId = foundFeature.properties.code;
        const regionName = foundFeature.properties.name;

        // Extract Date
        let travelDateStr = '';
        if (exif.DateTimeOriginal) {
            const dateObj = new Date(exif.DateTimeOriginal);
            travelDateStr = dateObj.toISOString().split('T')[0];
        } else {
            // Fallback
            const fileDate = new Date(file.lastModified);
            travelDateStr = fileDate.toISOString().split('T')[0];
        }

        // Resize image for localStorage
        const dataUrl = await resizeImage(file, 800);

        // Pre-fill the form and set state
        currentActiveRegion = regionId;
        currentActiveRegionName = regionName;
        regionNameTitle.textContent = regionName;

        showEditMode(false, {
            date: travelDateStr,
            photoData: dataUrl
        });

        openModal();

    } catch (error) {
        console.error('EXIF parsing error:', error);
        alert('사진을 분석하는 중 오류가 발생했습니다.');
    } finally {
        uploadPhotoBtn.textContent = '📸 사진으로 추가';
        photoUploadInput.value = ''; // Reset input
    }
});

function resizeImage(file, maxSize) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const img = new Image();
            img.onload = function () {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxSize) {
                        height *= maxSize / width;
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width *= maxSize / height;
                        height = maxSize;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.6));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Boot
document.addEventListener('DOMContentLoaded', initMap);
